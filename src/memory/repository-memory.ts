import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Session, SessionEvent } from '../session/session.js';
import { Workspace } from '../workspace/workspace.js';
import { computeFileHash, computeStringHash } from '../workspace/workspace-digest.js';
import { writeFileAtomically } from './atomic-write.js';
import { AgentMemoryClient, type AgentMemoryClientOptions } from './agentmemory-client.js';
import type {
  CitationValidation,
  RepositoryCitation,
  RepositoryMemoryInput,
  RepositoryMemoryRecallResult,
  RepositoryMemoryRecord,
  RepositoryMemoryStore,
  RepositoryMemoryValidation,
  SessionEventRepositoryCitation,
} from './repository-memory-types.js';

const execFileAsync = promisify(execFile);
const FAILURE = (result: Record<string, any>): boolean => Boolean(
  result.error || result.errorCode || result.success === false
  || (typeof result.exitCode === 'number' && result.exitCode !== 0),
);

function canonicalTokens(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[a-z0-9_$./-]{2,}/g) || []).slice(0, 500));
}

function boundedText(value: unknown, max = 700): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text || '')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret|private[_-]?key)\b\s*[:=]\s*["']?[^\s,"'}]+/gi, '$1=[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{12,}\b/gi, '[REDACTED_TOKEN]')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

function defaultStore(): RepositoryMemoryStore {
  return { version: 1, records: [] };
}

export interface RepositoryMemoryOptions {
  agentMemory?: AgentMemoryClientOptions;
  client?: AgentMemoryClient;
  minConfidence?: number;
}

/**
 * Independent, citation-first repository memory.
 *
 * Local citation manifests are authoritative. AgentMemory is an optional
 * semantic mirror and can never make an unverified record eligible for recall.
 */
export class CitationValidatedRepositoryMemory {
  private workspace: Workspace;
  private storePath: string;
  private observationsPath: string;
  private store: RepositoryMemoryStore = defaultStore();
  private readonly client: AgentMemoryClient;
  private readonly minConfidence: number;
  private boundSession?: Session;
  private initialized = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly seenObservationHashes = new Set<string>();

  constructor(workspace: Workspace | string, options: RepositoryMemoryOptions = {}) {
    this.workspace = typeof workspace === 'string' ? new Workspace(workspace) : workspace;
    this.storePath = this.resolveStorePath('records.json');
    this.observationsPath = this.resolveStorePath('observations.jsonl');
    this.client = options.client || new AgentMemoryClient(options.agentMemory);
    this.minConfidence = options.minConfidence ?? 0.68;
  }

  setWorkspace(workspace: Workspace | string): void {
    this.workspace = typeof workspace === 'string' ? new Workspace(workspace) : workspace;
    this.storePath = this.resolveStorePath('records.json');
    this.observationsPath = this.resolveStorePath('observations.jsonl');
    this.store = defaultStore();
    this.seenObservationHashes.clear();
    this.initialized = false;
    this.boundSession = undefined;
  }

  bindSession(session: Session): void {
    this.boundSession = session;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      const parsed = JSON.parse(await fs.readFile(this.storePath, 'utf8')) as RepositoryMemoryStore;
      this.store = parsed?.version === 1 && Array.isArray(parsed.records) ? parsed : defaultStore();
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      this.store = defaultStore();
    }
    try {
      const recent = (await fs.readFile(this.observationsPath, 'utf8')).split(/\r?\n/).filter(Boolean).slice(-2_000);
      for (const line of recent) {
        try {
          const item = JSON.parse(line);
          if (typeof item?.dedupHash === 'string') this.seenObservationHashes.add(item.dedupHash);
        } catch { /* ignore one malformed observation */ }
      }
    } catch { /* observation log is optional */ }
    this.initialized = true;
  }

  async remember(input: RepositoryMemoryInput): Promise<RepositoryMemoryRecord> {
    await this.init();
    const statement = input.statement.trim();
    if (!statement) throw new Error('Repository memory statement must not be empty.');
    if (!Array.isArray(input.citations) || input.citations.length === 0) {
      throw new Error('Citation-validated repository memory requires at least one citation.');
    }
    const validation = await this.validateCitations(input.citations);
    if (!validation.valid) {
      throw new Error(`Repository memory citation validation failed: ${validation.reasons.join('; ')}`);
    }

    const now = new Date().toISOString();
    const fingerprint = computeStringHash(JSON.stringify({ statement, citations: input.citations }));
    const existing = this.store.records.find((item) => computeStringHash(JSON.stringify({
      statement: item.statement,
      citations: item.citations,
    })) === fingerprint);
    const record: RepositoryMemoryRecord = {
      id: existing?.id || `repo-memory-${crypto.randomUUID()}`,
      statement,
      category: input.category || 'insight',
      source: input.source || 'manual',
      confidence: Math.max(0, Math.min(1, input.confidence ?? 0.8)),
      status: 'active',
      citations: input.citations,
      concepts: Array.from(new Set(input.concepts || [...canonicalTokens(statement)].slice(0, 16))),
      relatedFiles: Array.from(new Set([
        ...(input.relatedFiles || []),
        ...input.citations.flatMap((citation) => citation.kind === 'file' ? [citation.path] : []),
      ])),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      lastValidatedAt: now,
      accessCount: existing?.accessCount || 0,
      supersedes: input.supersedes,
    };
    this.store.records = this.store.records.filter((item) => item.id !== record.id);
    this.store.records.push(record);
    for (const supersededId of record.supersedes || []) {
      const superseded = this.store.records.find((item) => item.id === supersededId);
      if (superseded) superseded.status = 'superseded';
    }
    await this.persist();
    void this.client.remember({
      id: record.id,
      project: path.basename(this.workspace.rootDir),
      content: record.statement,
      concepts: record.concepts,
      files: record.relatedFiles,
      sourceObservationIds: record.citations.map((citation) => this.citationId(citation)),
      type: record.category,
    });
    return structuredClone(record);
  }

  async recall(query: string, options: { limit?: number; maxTokens?: number; includeStale?: boolean } = {}): Promise<RepositoryMemoryRecallResult> {
    await this.init();
    const queryTokens = canonicalTokens(query);
    const remote = query.trim()
      ? await this.client.smartSearch(query, Math.max(10, options.limit ?? 12))
      : { ids: [], available: await this.client.health() };
    const remoteRank = new Map(remote.ids.map((id, index) => [id, remote.ids.length - index]));
    const candidates = this.store.records
      .filter((record) => record.confidence >= this.minConfidence && record.status !== 'superseded')
      .map((record) => ({ record, score: this.score(record, queryTokens) + (remoteRank.get(record.id) || 0) * 3 }))
      .filter((item) => item.score > 0 || queryTokens.size === 0)
      .sort((left, right) => right.score - left.score || right.record.updatedAt.localeCompare(left.record.updatedAt))
      .slice(0, Math.max(1, Math.min(100, options.limit ?? 12)));

    const valid: RepositoryMemoryRecord[] = [];
    const staleIds: string[] = [];
    let changed = false;
    for (const candidate of candidates) {
      const validation = await this.validateRecord(candidate.record);
      const nextStatus = validation.valid ? 'active' : 'stale';
      if (candidate.record.status !== nextStatus || candidate.record.invalidReasons?.join('\n') !== validation.reasons.join('\n')) {
        candidate.record.status = nextStatus;
        candidate.record.invalidReasons = validation.valid ? undefined : validation.reasons;
        candidate.record.lastValidatedAt = new Date().toISOString();
        changed = true;
      }
      if (validation.valid || options.includeStale) {
        candidate.record.accessCount++;
        valid.push(structuredClone(candidate.record));
        changed = true;
      } else {
        staleIds.push(candidate.record.id);
      }
    }
    if (changed) await this.persist();

    const budget = Math.max(128, Math.min(8_000, options.maxTokens ?? 1_000));
    const lines = ['[CITATION-VALIDATED REPOSITORY MEMORY]'];
    let used = Math.ceil(lines[0].length / 3.8);
    const renderedRecords: RepositoryMemoryRecord[] = [];
    for (const record of valid) {
      const citationText = record.citations.map((citation) => this.renderCitation(citation)).join(', ');
      const line = `- [${record.category}; confidence=${record.confidence.toFixed(2)}; ${citationText}] ${record.statement}`;
      const cost = Math.ceil(line.length / 3.8);
      if (used + cost > budget) continue;
      lines.push(line);
      used += cost;
      renderedRecords.push(record);
    }
    return {
      records: renderedRecords,
      rendered: renderedRecords.length > 0 ? lines.join('\n') : '',
      staleIds,
      remoteAvailable: remote.available,
    };
  }

  async verify(id: string): Promise<RepositoryMemoryValidation> {
    await this.init();
    const record = this.store.records.find((item) => item.id === id);
    if (!record) return { valid: false, validations: [], reasons: [`Unknown repository memory: ${id}`] };
    const validation = await this.validateRecord(record);
    record.status = validation.valid ? 'active' : 'stale';
    record.invalidReasons = validation.valid ? undefined : validation.reasons;
    record.lastValidatedAt = new Date().toISOString();
    await this.persist();
    return validation;
  }

  async createFileCitation(filePath: string, lineStart?: number, lineEnd?: number): Promise<RepositoryCitation> {
    const safePath = this.workspace.resolveSafePath(filePath);
    const relative = this.workspace.toRelativePath(safePath);
    if (lineStart !== undefined || lineEnd !== undefined) {
      const lines = (await fs.readFile(safePath, 'utf8')).split(/\r?\n/);
      const start = Math.max(1, lineStart || 1);
      const end = Math.max(start, lineEnd || start);
      return { kind: 'file', path: relative, lineStart: start, lineEnd: end, contentHash: computeStringHash(lines.slice(start - 1, end).join('\n')) };
    }
    return { kind: 'file', path: relative, contentHash: await computeFileHash(safePath) };
  }

  async observeToolResult(session: Session, toolName: string, args: Record<string, any>, result: Record<string, any>, eventSeq: number): Promise<void> {
    if (FAILURE(result)) return;
    const citation: SessionEventRepositoryCitation = {
      kind: 'session-event', sessionId: session.id, eventSeq, eventType: 'tool/result', toolName, outcome: 'success',
    };
    const target = boundedText(args.path || args.filePath || result.path || result.filePath || '');
    if (/(^|[\\/])\.env(?:\.|$)|credential|secret/i.test(target)) return;
    const summary = boundedText(result.summary || result.stdout || result.content || result.message || result);
    const dedupHash = computeStringHash(JSON.stringify({ toolName, target, summary }));
    if (this.seenObservationHashes.has(dedupHash)) return;
    this.seenObservationHashes.add(dedupHash);
    const observation = {
      id: this.citationId(citation),
      observedAt: new Date().toISOString(),
      toolName,
      target,
      summary,
      dedupHash,
      citation,
    };
    await this.enqueue(async () => {
      await fs.mkdir(path.dirname(this.observationsPath), { recursive: true });
      await fs.appendFile(this.observationsPath, `${JSON.stringify(observation)}\n`, 'utf8');
    });
    void this.client.remember({
      id: observation.id,
      project: path.basename(this.workspace.rootDir),
      content: `${toolName}${target ? ` ${target}` : ''}: ${summary}`,
      concepts: [toolName, ...canonicalTokens(target)].slice(0, 12),
      files: target && !/\s/.test(target) ? [target] : [],
      sourceObservationIds: [observation.id],
      type: 'tool-observation',
    });
  }

  async validateCitations(citations: RepositoryCitation[]): Promise<RepositoryMemoryValidation> {
    const validations: CitationValidation[] = [];
    for (const citation of citations) validations.push(await this.validateCitation(citation));
    const reasons = validations.filter((item) => !item.valid).map((item) => item.reason || 'Invalid citation.');
    return { valid: validations.length > 0 && reasons.length === 0, validations, reasons };
  }

  private async validateRecord(record: RepositoryMemoryRecord): Promise<RepositoryMemoryValidation> {
    if (record.status === 'contested' || record.status === 'superseded') {
      return { valid: false, validations: [], reasons: [`Memory status is ${record.status}.`] };
    }
    return this.validateCitations(record.citations);
  }

  private async validateCitation(citation: RepositoryCitation): Promise<CitationValidation> {
    try {
      if (citation.kind === 'file') {
        const safePath = this.workspace.resolveSafePath(citation.path);
        let actual: string;
        if (citation.lineStart !== undefined || citation.lineEnd !== undefined) {
          const lines = (await fs.readFile(safePath, 'utf8')).split(/\r?\n/);
          const start = Math.max(1, citation.lineStart || 1);
          const end = Math.max(start, citation.lineEnd || start);
          actual = computeStringHash(lines.slice(start - 1, end).join('\n'));
        } else {
          actual = await computeFileHash(safePath);
        }
        return actual === citation.contentHash
          ? { citation, valid: true }
          : { citation, valid: false, reason: `File citation changed: ${citation.path}.` };
      }
      if (citation.kind === 'session-event') {
        const event = await this.loadSessionEvent(citation.sessionId, citation.eventSeq);
        if (!event) return { citation, valid: false, reason: `Session event not found: ${citation.sessionId}#${citation.eventSeq}.` };
        if (citation.eventId && event.id !== citation.eventId) return { citation, valid: false, reason: `Session event id mismatch at ${citation.sessionId}#${citation.eventSeq}.` };
        if (citation.eventType && event.type !== citation.eventType) return { citation, valid: false, reason: `Session event type mismatch at ${citation.sessionId}#${citation.eventSeq}.` };
        if (citation.toolName && event.data.toolName !== citation.toolName) return { citation, valid: false, reason: `Tool mismatch at ${citation.sessionId}#${citation.eventSeq}.` };
        if (citation.outcome && event.type === 'tool/result') {
          const actual = FAILURE(event.data.result || {}) ? 'failure' : 'success';
          if (actual !== citation.outcome) return { citation, valid: false, reason: `Tool outcome mismatch at ${citation.sessionId}#${citation.eventSeq}.` };
        }
        return { citation, valid: true };
      }
      if (citation.kind === 'commit') {
        if (!/^[0-9a-f]{7,64}$/i.test(citation.commit)) return { citation, valid: false, reason: `Invalid commit id: ${citation.commit}.` };
        await execFileAsync('git', ['cat-file', '-e', `${citation.commit}^{commit}`], { cwd: this.workspace.rootDir });
        return { citation, valid: true };
      }
      const ledger = path.join(this.workspace.rootDir, '.codingagent', 'dream', 'compose-completions.jsonl');
      const lines = (await fs.readFile(ledger, 'utf8')).split(/\r?\n/).filter(Boolean);
      const match = lines.map((line) => { try { return JSON.parse(line); } catch { return undefined; } })
        .find((item) => item?.composeId === citation.composeId && (!citation.specHash || item.specHash === citation.specHash));
      return match ? { citation, valid: true } : { citation, valid: false, reason: `Compose completion not found: ${citation.composeId}.` };
    } catch (error: any) {
      return { citation, valid: false, reason: error?.message || String(error) };
    }
  }

  private async loadSessionEvent(sessionId: string, eventSeq: number): Promise<SessionEvent | undefined> {
    if (this.boundSession?.id === sessionId) return this.boundSession.getEvents().find((event) => event.seq === eventSeq);
    const safeId = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
    try {
      const lines = (await fs.readFile(path.join(this.workspace.rootDir, '.codingagent', 'sessions', `${safeId}.jsonl`), 'utf8'))
        .split(/\r?\n/).filter(Boolean).slice(1);
      for (const line of lines) {
        const event = JSON.parse(line) as SessionEvent;
        if (event.seq === eventSeq) return event;
      }
    } catch { /* missing or malformed evidence is invalid */ }
    return undefined;
  }

  private score(record: RepositoryMemoryRecord, queryTokens: Set<string>): number {
    const haystack = canonicalTokens(`${record.statement} ${record.concepts.join(' ')} ${record.relatedFiles.join(' ')}`);
    let overlap = 0;
    for (const token of queryTokens) if (haystack.has(token)) overlap++;
    const freshness = Math.max(0, 1 - (Date.now() - Date.parse(record.updatedAt)) / (365 * 24 * 60 * 60 * 1000));
    return overlap * 4 + record.confidence * 2 + freshness * 0.25 + Math.min(record.accessCount, 20) * 0.01;
  }

  private renderCitation(citation: RepositoryCitation): string {
    if (citation.kind === 'file') return `${citation.path}${citation.lineStart ? `:L${citation.lineStart}${citation.lineEnd && citation.lineEnd !== citation.lineStart ? `-L${citation.lineEnd}` : ''}` : ''}@${citation.contentHash.slice(0, 15)}`;
    if (citation.kind === 'session-event') return `${citation.sessionId}#${citation.eventSeq}${citation.toolName ? `:${citation.toolName}` : ''}`;
    if (citation.kind === 'commit') return `commit:${citation.commit.slice(0, 12)}`;
    return `compose:${citation.composeId}`;
  }

  private citationId(citation: RepositoryCitation): string {
    return computeStringHash(JSON.stringify(citation));
  }

  private resolveStorePath(name: string): string {
    return path.join(this.workspace.rootDir, '.codingagent', 'repository-memory', name);
  }

  private async persist(): Promise<void> {
    await this.enqueue(async () => {
      await fs.mkdir(path.dirname(this.storePath), { recursive: true });
      await writeFileAtomically(this.storePath, JSON.stringify(this.store, null, 2));
    });
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.catch(() => {});
    await next;
  }
}
