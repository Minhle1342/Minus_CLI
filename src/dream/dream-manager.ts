import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProjectMemoryManager, MemoryConsolidationPlan } from '../memory/project-memory.js';
import type { MemoryProvenance, MemoryRecord } from '../memory/types.js';
import { writeFileAtomically } from '../memory/atomic-write.js';
import { Workspace } from '../workspace/workspace.js';
import { CodestralDreamAgent } from './codestral-dream-agent.js';
import { DreamTrajectoryReader } from './trajectory-reader.js';
import type {
  DreamAgent,
  DreamConfig,
  DreamEvidence,
  DreamProposal,
  DreamRunReport,
  DreamState,
  VerifiedDreamMemory,
} from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function resolveDreamConfig(overrides: Partial<DreamConfig> = {}): DreamConfig {
  const enabledValue = String(process.env.DREAM_AUTO || 'true').trim().toLowerCase();
  return {
    enabled: !['0', 'false', 'off', 'no'].includes(enabledValue),
    intervalMs: positiveInt(process.env.DREAM_INTERVAL_HOURS, 24 * 7) * 60 * 60 * 1000,
    maxSessions: positiveInt(process.env.DREAM_MAX_SESSIONS, 80),
    maxEvents: positiveInt(process.env.DREAM_MAX_EVENTS, 2500),
    maxInputChars: positiveInt(process.env.DREAM_MAX_INPUT_CHARS, 90_000),
    maxProposals: positiveInt(process.env.DREAM_MAX_PROPOSALS, 24),
    minEvidence: positiveInt(process.env.DREAM_MIN_EVIDENCE, 8),
    lockStaleMs: positiveInt(process.env.DREAM_LOCK_STALE_MINUTES, 30) * 60 * 1000,
    ...overrides,
  };
}

function defaultState(): DreamState {
  return { version: 1, cursors: {} };
}

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function canonicalKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
}

function redactComposeText(value: string): string {
  return value
    .replace(/\b((?:api[_-]?key|token|password|secret))\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]');
}

function provenanceFor(evidence: DreamEvidence[]): MemoryProvenance[] {
  return evidence.map((item) => ({
    evidenceId: item.id,
    sessionId: item.sessionId,
    eventSeq: item.eventSeq,
    kind: item.kind,
    createdAt: item.createdAt,
  }));
}

function uniqueProvenance(items: MemoryProvenance[]): MemoryProvenance[] {
  return Array.from(new Map(items.map((item) => [item.evidenceId, item])).values()).slice(-40);
}

interface PolicyResult {
  plan: MemoryConsolidationPlan;
  accepted: VerifiedDreamMemory[];
  rejected: number;
  preview: Array<{ key: string; action: string; confidence: number; evidence: number }>;
}

export interface DreamStatus {
  enabled: boolean;
  configured: boolean;
  model: string;
  intervalHours: number;
  due: boolean;
  running: boolean;
  lastRunAt?: string;
  lastReport?: DreamRunReport;
  cursorCount: number;
}

export interface ComposeDreamCompletion {
  composeId: string;
  featureName: string;
  objective: string;
  specHash: string;
  testEvidence: string[];
  reviewSummary: string;
}

export class DreamManager {
  private workspaceDir: string;
  private statePath: string;
  private lockPath: string;
  private memory: ProjectMemoryManager;
  private readonly agent: DreamAgent;
  private readonly reader: DreamTrajectoryReader;
  private readonly config: DreamConfig;
  private currentRun?: Promise<DreamRunReport>;

  constructor(
    workspaceDir: string,
    memory: ProjectMemoryManager,
    options: {
      agent?: DreamAgent;
      reader?: DreamTrajectoryReader;
      config?: Partial<DreamConfig>;
    } = {},
  ) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.memory = memory;
    this.agent = options.agent || new CodestralDreamAgent();
    this.reader = options.reader || new DreamTrajectoryReader(this.workspaceDir);
    this.config = resolveDreamConfig(options.config);
    this.statePath = path.join(this.workspaceDir, '.codingagent', 'dream', 'state.json');
    this.lockPath = path.join(this.workspaceDir, '.codingagent', 'dream', 'dream.lock');
  }

  setWorkspace(workspaceDir: string, memory: ProjectMemoryManager): void {
    this.workspaceDir = path.resolve(workspaceDir);
    this.memory = memory;
    this.reader.setWorkspace(this.workspaceDir);
    this.statePath = path.join(this.workspaceDir, '.codingagent', 'dream', 'state.json');
    this.lockPath = path.join(this.workspaceDir, '.codingagent', 'dream', 'dream.lock');
  }

  async status(): Promise<DreamStatus> {
    const state = await this.loadState();
    return {
      enabled: this.config.enabled,
      configured: this.agent.isConfigured(),
      model: `mistral/${this.agent.model}`,
      intervalHours: this.config.intervalMs / (60 * 60 * 1000),
      due: this.isDue(state),
      running: Boolean(this.currentRun),
      lastRunAt: state.lastRunAt,
      lastReport: state.lastReport,
      cursorCount: Object.keys(state.cursors).length,
    };
  }

  async runIfDue(): Promise<DreamRunReport> {
    return this.run({ mode: 'auto', force: false });
  }

  /** Persist verified Compose outcomes as deterministic Dream input; no live model call occurs here. */
  async recordComposeCompletion(completion: ComposeDreamCompletion): Promise<{ model: string; agentUsed: boolean; accepted: number; error?: string }> {
    const recordedAt = new Date().toISOString();
    const safeCompletion = {
      ...completion,
      objective: redactComposeText(completion.objective),
      reviewSummary: redactComposeText(completion.reviewSummary),
      testEvidence: completion.testEvidence.map(redactComposeText),
    };
    const record = { ...safeCompletion, recordedAt };
    const ledgerPath = path.join(this.workspaceDir, '.codingagent', 'dream', 'compose-completions.jsonl');
    let ledger = '';
    try { ledger = await fs.readFile(ledgerPath, 'utf8'); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
    await writeFileAtomically(ledgerPath, `${ledger}${JSON.stringify(record)}\n`);

    const insightPath = path.join(this.workspaceDir, '.knowledge', 'DREAM_INSIGHTS.md');
    let markdown = '# Dream Insights\n\nVerified outcomes captured from completed Compose runs.\n';
    try { markdown = await fs.readFile(insightPath, 'utf8'); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    let acceptedInsights: VerifiedDreamMemory[] = [];
    let dreamError: string | undefined;
    if (this.agent.isConfigured()) {
      const evidence: DreamEvidence[] = [
        { id: `compose:${completion.composeId}:objective`, sessionId: `compose:${completion.composeId}`, eventSeq: 1, createdAt: recordedAt, kind: 'human', text: safeCompletion.objective, verified: true },
        ...safeCompletion.testEvidence.map((item, index): DreamEvidence => ({ id: `compose:${completion.composeId}:test:${index + 1}`, sessionId: `compose:${completion.composeId}`, eventSeq: index + 2, createdAt: recordedAt, kind: 'tool-success', text: item, verified: true })),
        { id: `compose:${completion.composeId}:review`, sessionId: `compose:${completion.composeId}`, eventSeq: safeCompletion.testEvidence.length + 2, createdAt: recordedAt, kind: 'audit', text: safeCompletion.reviewSummary, verified: true },
      ];
      try {
        await this.memory.init(new Workspace(this.workspaceDir));
        const existing = this.memory.getMemoryData().learnedInsights.map((item) => ({
          id: item.id || `memory-${item.key}`, key: item.key, insight: item.insight,
          category: item.category || 'insight', confidence: item.confidence ?? 0, trustStatus: item.trustStatus || 'active',
        }));
        const proposals = await this.agent.propose({ evidence, existingMemory: existing, maxProposals: this.config.maxProposals });
        const policy = this.verifyProposals(proposals, evidence);
        await this.memory.applyConsolidation(policy.plan);
        acceptedInsights = policy.accepted;
      } catch (error: any) {
        dreamError = error?.message || String(error);
      }
    }
    const learned = acceptedInsights.length > 0
      ? `- Codestral insights:\n${acceptedInsights.map((item) => `  - ${item.insight} (confidence=${item.confidence.toFixed(2)})`).join('\n')}\n`
      : `- Codestral insights: none accepted${dreamError ? ` (${redactComposeText(dreamError)})` : ''}\n`;
    const section = `\n## ${safeCompletion.featureName} (${recordedAt})\n\n- Compose: \`${safeCompletion.composeId}\`\n- Spec SHA-256: \`${safeCompletion.specHash}\`\n- Independent Dream model: \`mistral/${this.agent.model}\`\n- Objective: ${safeCompletion.objective}\n- Review: ${safeCompletion.reviewSummary}\n- Evidence:\n${safeCompletion.testEvidence.map((item) => `  - ${item}`).join('\n')}\n${learned}`;
    await fs.mkdir(path.dirname(insightPath), { recursive: true });
    await writeFileAtomically(insightPath, `${markdown.trimEnd()}\n${section}`);
    return { model: `mistral/${this.agent.model}`, agentUsed: this.agent.isConfigured(), accepted: acceptedInsights.length, ...(dreamError ? { error: dreamError } : {}) };
  }

  async run(options: { mode?: 'apply' | 'preview' | 'auto'; force?: boolean } = {}): Promise<DreamRunReport> {
    if (this.currentRun) return this.currentRun;
    const task = this.runInternal(options).finally(() => {
      if (this.currentRun === task) this.currentRun = undefined;
    });
    this.currentRun = task;
    return task;
  }

  private async runInternal(options: { mode?: 'apply' | 'preview' | 'auto'; force?: boolean }): Promise<DreamRunReport> {
    const mode = options.mode || 'apply';
    const startedAt = new Date().toISOString();
    const runId = `dream-${randomUUID()}`;
    const base = {
      runId,
      model: `mistral/${this.agent.model}`,
      mode,
      startedAt,
      scannedSessions: 0,
      scannedEvents: 0,
      evidenceCount: 0,
      proposals: 0,
      accepted: 0,
      rejected: 0,
      upserted: 0,
      superseded: 0,
      pruned: 0,
    };
    const skipped = (reason: string): DreamRunReport => ({
      ...base,
      status: 'skipped',
      reason,
      finishedAt: new Date().toISOString(),
    });

    const state = await this.loadState();
    if (mode === 'auto' && !this.config.enabled) return skipped('Automatic Dream is disabled.');
    if (!this.agent.isConfigured()) return skipped('MISTRAL_API_KEY is not configured.');
    if (!options.force && mode === 'auto' && !this.isDue(state)) return skipped('Dream interval has not elapsed.');

    const release = await this.acquireLock(runId);
    if (!release) return skipped('Another Dream process owns the workspace lock.');

    try {
      const scan = await this.reader.scan(state.cursors, this.config);
      Object.assign(base, {
        scannedSessions: scan.scannedSessions,
        scannedEvents: scan.scannedEvents,
        evidenceCount: scan.evidence.length,
      });
      if (scan.evidence.length === 0) return skipped('No new durable trajectory evidence.');
      if (mode === 'auto' && scan.evidence.length < this.config.minEvidence) {
        return skipped(`Only ${scan.evidence.length} evidence items; waiting for ${this.config.minEvidence}.`);
      }

      const existing = this.memory.getMemoryData().learnedInsights.map((item) => ({
        id: item.id || `memory-${item.key}`,
        key: item.key,
        insight: item.insight,
        category: item.category || 'insight',
        confidence: item.confidence ?? 0,
        trustStatus: item.trustStatus || 'active',
      }));
      const proposals = await this.agent.propose({
        evidence: scan.evidence,
        existingMemory: existing,
        maxProposals: this.config.maxProposals,
      });
      base.proposals = proposals.length;
      const policy = this.verifyProposals(proposals, scan.evidence);
      base.accepted = policy.accepted.length;
      base.rejected = policy.rejected;

      if (mode === 'preview') {
        return {
          ...base,
          status: 'completed',
          finishedAt: new Date().toISOString(),
          preview: policy.preview,
        };
      }

      const result = await this.memory.applyConsolidation(policy.plan);
      base.upserted = result.upserted;
      base.superseded = result.superseded;
      base.pruned = result.pruned;
      const report: DreamRunReport = {
        ...base,
        status: 'completed',
        finishedAt: new Date().toISOString(),
        preview: policy.preview,
      };
      await this.saveState({
        version: 1,
        cursors: scan.nextCursors,
        lastRunAt: report.finishedAt,
        lastSuccessfulRunId: runId,
        lastReport: report,
      });
      return report;
    } catch (error: any) {
      const report: DreamRunReport = {
        ...base,
        status: 'failed',
        reason: error?.message || String(error),
        finishedAt: new Date().toISOString(),
      };
      // Preserve watermarks and lastRunAt so a failed run is safely replayable.
      await this.saveState({ ...state, lastReport: report });
      return report;
    } finally {
      await release();
    }
  }

  private verifyProposals(proposals: DreamProposal[], evidence: DreamEvidence[]): PolicyResult {
    const evidenceById = new Map(evidence.map((item) => [item.id, item]));
    const existing = this.memory.getMemoryData().learnedInsights.map((item) => item as MemoryRecord);
    const upserts: MemoryRecord[] = [];
    const supersede: MemoryConsolidationPlan['supersede'] = [];
    const pruneIds = this.housekeeping(existing);
    const accepted: VerifiedDreamMemory[] = [];
    const preview: PolicyResult['preview'] = [];
    let rejected = 0;

    for (const proposal of proposals) {
      const key = canonicalKey(proposal.key);
      const cited = proposal.evidenceIds.map((id) => evidenceById.get(id)).filter((item): item is DreamEvidence => Boolean(item));
      const verified = cited.filter((item) => item.verified);
      const humanSessions = new Set(cited.filter((item) => item.kind === 'human').map((item) => item.sessionId));
      const verifiedSessions = new Set(verified.map((item) => item.sessionId));
      let confidenceCap = 0;
      if (verified.length > 0) confidenceCap = verified.length > 1 || verifiedSessions.size > 1 ? 0.96 : 0.92;
      else if (humanSessions.size >= 2) confidenceCap = 0.86;
      else if (humanSessions.size === 1) confidenceCap = 0.82;
      const confidence = Math.min(proposal.confidence, confidenceCap);
      if (!key || cited.length === 0 || confidence < 0.7) {
        rejected++;
        continue;
      }

      const sameKey = existing.filter((item) => canonicalKey(item.key) === key && !pruneIds.includes(item.id));
      if (proposal.action === 'forget') {
        const removable = sameKey.filter((item) => item.trustStatus !== 'active'
          || Boolean(item.expiresAt && Date.parse(item.expiresAt) <= Date.now()));
        if (removable.length === 0 || verified.length === 0) {
          rejected++;
          continue;
        }
        pruneIds.push(...removable.map((item) => item.id));
        preview.push({ key, action: 'forget', confidence, evidence: cited.length });
        continue;
      }

      const insight = proposal.insight?.trim();
      if (!insight) {
        rejected++;
        continue;
      }
      const provenance = provenanceFor(cited);
      const exact = sameKey.find((item) => normalizedText(item.insight) === normalizedText(insight));
      const activeConflicts = sameKey.filter((item) => item.trustStatus === 'active'
        && normalizedText(item.insight) !== normalizedText(insight));
      const strongestConflict = [...activeConflicts]
        .sort((a, b) => b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt))[0];
      if (strongestConflict) {
        const strongCrossSessionEvidence = verifiedSessions.size >= 2;
        if (confidence < strongestConflict.confidence || (confidence === strongestConflict.confidence && !strongCrossSessionEvidence)) {
          rejected++;
          continue;
        }
      }

      const now = new Date().toISOString();
      const id = exact?.id || `memory-dream-${randomUUID()}`;
      const verifiedMemory: VerifiedDreamMemory = {
        key,
        insight,
        category: proposal.category || 'insight',
        confidence,
        tags: Array.from(new Set(proposal.tags || [])).slice(0, 8),
        provenance,
      };
      const record: MemoryRecord = {
        id,
        key,
        insight,
        category: verifiedMemory.category,
        scope: 'project',
        source: 'dream',
        confidence: Math.max(exact?.confidence || 0, confidence),
        trustStatus: 'active',
        createdAt: exact?.createdAt || now,
        updatedAt: now,
        tags: Array.from(new Set([...(exact?.tags || []), ...verifiedMemory.tags])),
        provenance: uniqueProvenance([...(exact?.provenance || []), ...provenance]),
        verifiedAt: now,
        sourceEventSeq: provenance.at(-1)?.eventSeq,
      };
      upserts.push(record);
      for (const activeConflict of activeConflicts) {
        if (activeConflict.id !== id) {
          supersede.push({
            id: activeConflict.id,
            supersededBy: id,
            reason: `Superseded by verified Dream evidence (${provenance.map((item) => item.evidenceId).join(', ')}).`,
          });
        }
      }
      for (const duplicate of sameKey.filter((item) => item.id !== id && item.trustStatus === 'contested')) {
        pruneIds.push(duplicate.id);
      }
      accepted.push(verifiedMemory);
      preview.push({ key, action: exact ? 'merge' : strongestConflict ? 'supersede' : 'remember', confidence, evidence: cited.length });
    }

    return {
      plan: {
        upserts,
        supersede,
        pruneIds: Array.from(new Set(pruneIds)).filter((id) => !upserts.some((item) => item.id === id)),
      },
      accepted,
      rejected,
      preview,
    };
  }

  private housekeeping(records: MemoryRecord[]): string[] {
    const prune = new Set<string>();
    const groups = new Map<string, MemoryRecord[]>();
    const now = Date.now();
    for (const record of records) {
      if (record.source !== 'manual' && record.expiresAt && Date.parse(record.expiresAt) <= now) prune.add(record.id);
      if (record.trustStatus === 'superseded' && now - Date.parse(record.updatedAt) > 30 * DAY_MS) prune.add(record.id);
      const signature = `${canonicalKey(record.key)}\u0000${normalizedText(record.insight)}\u0000${record.trustStatus}`;
      const group = groups.get(signature) || [];
      group.push(record);
      groups.set(signature, group);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const keep = [...group].sort((a, b) => b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt))[0];
      for (const record of group) if (record.id !== keep.id) prune.add(record.id);
    }
    return Array.from(prune);
  }

  private isDue(state: DreamState): boolean {
    if (!state.lastRunAt) return true;
    const last = Date.parse(state.lastRunAt);
    return !Number.isFinite(last) || Date.now() - last >= this.config.intervalMs;
  }

  private async loadState(): Promise<DreamState> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath, 'utf8')) as DreamState;
      return parsed?.version === 1 && parsed.cursors ? parsed : defaultState();
    } catch (error: any) {
      if (error?.code === 'ENOENT') return defaultState();
      return defaultState();
    }
  }

  private async saveState(state: DreamState): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await writeFileAtomically(this.statePath, JSON.stringify(state, null, 2));
  }

  private async acquireLock(runId: string): Promise<(() => Promise<void>) | undefined> {
    await fs.mkdir(path.dirname(this.lockPath), { recursive: true });
    const tryCreate = async () => {
      const handle = await fs.open(this.lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ runId, pid: process.pid, createdAt: new Date().toISOString() }));
      return async () => {
        await handle.close().catch(() => {});
        await fs.unlink(this.lockPath).catch(() => {});
      };
    };
    try {
      return await tryCreate();
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const stat = await fs.stat(this.lockPath);
        if (Date.now() - stat.mtimeMs <= this.config.lockStaleMs) return undefined;
        await fs.unlink(this.lockPath);
        return await tryCreate();
      } catch (retryError: any) {
        if (retryError?.code === 'ENOENT') return tryCreate();
        return undefined;
      }
    }
  }
}
