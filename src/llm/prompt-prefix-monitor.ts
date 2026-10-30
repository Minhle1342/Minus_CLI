import { nativeComputeStringHash } from '../native/index.js';
import { canonicalizePromptText, type PromptCacheTier } from './cache-envelope.js';

/**
 * Prompt-prefix churn telemetry (P0.1).
 *
 * Provider KV/prompt cache chỉ trúng khi phần prefix (system prompt + tool schema)
 * giữ nguyên byte-for-byte giữa các request. Đo `cacheHitRate` một mình không cho
 * biết *vì sao* trượt, nên monitor này băm riêng system prompt và tool set, so với
 * request trước của cùng session và ghi lại nguyên nhân thay đổi.
 *
 * Thuần quan sát: không chạm payload gửi provider, không đổi hành vi agent.
 */

export type PromptPrefixChangeReason =
  | 'system-prompt'
  | 'stable-prefix'
  | 'tool-set'
  | 'new-turn'
  | 'compaction'
  | 'phase';

export interface PromptPrefixSectionDigest {
  id: string;
  tier: PromptCacheTier;
  contentHash: string;
}

export interface PromptPrefixObservation {
  sessionId: string;
  turn: number;
  step: number;
  systemPrompt: string;
  tools: unknown[];
  phase?: string;
  /** True khi history vừa được thay bởi compaction trong step này. */
  compacted?: boolean;
  /**
   * Hash T0..T2 từ prompt envelope. Khi có, `changed` phản ánh phần prefix thật sự
   * ảnh hưởng KV cache, nên thay đổi chỉ ở T3 (dynamic tail) không bị báo là churn.
   */
  stablePrefixHash?: string;
  /** Hash từng section để quy trách nhiệm churn về đúng section id. */
  sections?: PromptPrefixSectionDigest[];
}

export interface PromptPrefixChurnReport {
  sessionId: string;
  turn: number;
  step: number;
  changed: boolean;
  systemChanged: boolean;
  toolsChanged: boolean;
  turnChanged: boolean;
  /** True khi prefix T0..T2 đổi (chỉ có ý nghĩa khi observation mang stablePrefixHash). */
  stablePrefixChanged: boolean;
  /** Churn của prefix ổn định mà không có biên hợp lệ (turn/phase/tool/compaction). */
  unexpectedStableChurn: boolean;
  changedTiers: PromptCacheTier[];
  changedSections: string[];
  systemHash: string;
  toolsHash: string;
  toolCount: number;
  phase?: string;
  previousTurn?: number;
  previousStep?: number;
  reasons: PromptPrefixChangeReason[];
}

export interface PromptPrefixChurnStats {
  observations: number;
  changes: number;
  systemChanges: number;
  toolsChanges: number;
  turnChanges: number;
  trackedSessions: number;
}

export const MAX_TRACKED_PREFIX_SESSIONS = 64;
export const MAX_PREFIX_CHURN_HISTORY = 50;
/** Giới hạn số section id trong một report để event không phình. */
export const MAX_REPORTED_CHANGED_SECTIONS = 24;

interface LastPrefix {
  systemHash: string;
  toolsHash: string;
  toolCount: number;
  turn: number;
  step: number;
  phase?: string;
  stablePrefixHash?: string;
  sections?: Record<string, { tier: PromptCacheTier; contentHash: string }>;
}

/** 128 bit là đủ để phát hiện đổi prefix; cắt bớt cho event gọn. */
function hashText(value: string): string {
  return nativeComputeStringHash(value).slice(0, 32);
}

/** Key-order-insensitive JSON để không báo "đổi" khi cùng schema được dựng lại. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function toolName(tool: unknown): string {
  const value = tool as { name?: unknown; function?: { name?: unknown } } | null;
  const name = value?.name ?? value?.function?.name;
  return typeof name === 'string' ? name : '';
}

export function hashPromptPrefixSystem(systemPrompt: string): string {
  return hashText(canonicalizePromptText(systemPrompt || ''));
}

export function hashPromptPrefixTools(tools: unknown[]): string {
  const sorted = [...(Array.isArray(tools) ? tools : [])]
    .sort((left, right) => toolName(left).localeCompare(toolName(right)));
  return hashText(stableStringify(sorted));
}

function sectionDigestMap(
  sections: PromptPrefixSectionDigest[],
): Record<string, { tier: PromptCacheTier; contentHash: string }> {
  const map: Record<string, { tier: PromptCacheTier; contentHash: string }> = {};
  for (const section of sections) {
    if (section?.id) map[section.id] = { tier: section.tier, contentHash: section.contentHash };
  }
  return map;
}

function diffSectionDigests(
  previous: LastPrefix['sections'],
  next: PromptPrefixSectionDigest[] | undefined,
): { ids: string[]; tiers: PromptCacheTier[] } {
  if (!previous || !next) return { ids: [], tiers: [] };
  const nextMap = sectionDigestMap(next);
  const changed = new Set<string>();
  for (const [id, prior] of Object.entries(previous)) {
    const current = nextMap[id];
    if (!current || current.contentHash !== prior.contentHash) changed.add(id);
  }
  for (const id of Object.keys(nextMap)) {
    if (!(id in previous)) changed.add(id);
  }
  // Chỉ section thuộc prefix ổn định (T0..T2) mới là nguyên nhân cache miss;
  // thay đổi T3 là phần dynamic tail có chủ đích nên không quy trách nhiệm churn.
  const ids = Array.from(changed)
    .filter((id) => {
      const tier = (nextMap[id] ?? previous[id])?.tier;
      return tier !== undefined && tier !== 'T3';
    })
    .sort()
    .slice(0, MAX_REPORTED_CHANGED_SECTIONS);
  const tiers = Array.from(new Set(ids
    .map((id) => (nextMap[id] ?? previous[id])?.tier)
    .filter((tier): tier is PromptCacheTier => Boolean(tier))));
  return { ids, tiers };
}

export class PromptPrefixMonitor {
  private readonly lastBySession = new Map<string, LastPrefix>();
  private readonly history: PromptPrefixChurnReport[] = [];
  private readonly totals: Omit<PromptPrefixChurnStats, 'trackedSessions'> = {
    observations: 0,
    changes: 0,
    systemChanges: 0,
    toolsChanges: 0,
    turnChanges: 0,
  };

  observe(input: PromptPrefixObservation): PromptPrefixChurnReport {
    const systemHash = hashPromptPrefixSystem(input.systemPrompt);
    const tools = Array.isArray(input.tools) ? input.tools : [];
    const toolsHash = hashPromptPrefixTools(tools);
    const previous = this.lastBySession.get(input.sessionId);

    const systemChanged = Boolean(previous) && previous!.systemHash !== systemHash;
    const toolsChanged = Boolean(previous) && previous!.toolsHash !== toolsHash;
    const turnChanged = Boolean(previous) && previous!.turn !== input.turn;
    const phaseChanged = Boolean(previous) && previous!.phase !== input.phase;

    // P2: khi có hash T0..T2, churn được đánh giá trên prefix thật sự ảnh hưởng
    // KV cache. Thay đổi chỉ ở T3 (dynamic tail) không còn bị báo là churn.
    const hasStableSignal = Boolean(previous)
      && previous!.stablePrefixHash !== undefined
      && input.stablePrefixHash !== undefined;
    const stablePrefixChanged = hasStableSignal
      && previous!.stablePrefixHash !== input.stablePrefixHash;
    const sectionDiff = hasStableSignal
      ? diffSectionDigests(previous!.sections, input.sections)
      : { ids: [] as string[], tiers: [] as PromptCacheTier[] };

    const changed = hasStableSignal
      ? (stablePrefixChanged || toolsChanged || turnChanged)
      : (systemChanged || toolsChanged || turnChanged);

    const reasons: PromptPrefixChangeReason[] = [];
    if (stablePrefixChanged) reasons.push('stable-prefix');
    if (systemChanged && !hasStableSignal) reasons.push('system-prompt');
    if (toolsChanged) reasons.push('tool-set');
    if (turnChanged) reasons.push('new-turn');
    if (phaseChanged && changed) reasons.push('phase');
    if (input.compacted && changed) reasons.push('compaction');

    // Biên hợp lệ để prefix ổn định được phép đổi: turn mới, đổi phase, tool set
    // đổi, hoặc compaction. Ngoài các biên này mà T0..T2 đổi là dấu hiệu prompt
    // không còn static-first (bug cần điều tra).
    const allowedBoundary = turnChanged || phaseChanged || toolsChanged || input.compacted === true;
    const unexpectedStableChurn = stablePrefixChanged && !allowedBoundary;

    const report: PromptPrefixChurnReport = {
      sessionId: input.sessionId,
      turn: input.turn,
      step: input.step,
      changed,
      systemChanged,
      toolsChanged,
      turnChanged,
      stablePrefixChanged,
      unexpectedStableChurn,
      changedTiers: sectionDiff.tiers,
      changedSections: sectionDiff.ids,
      systemHash,
      toolsHash,
      toolCount: tools.length,
      ...(input.phase ? { phase: input.phase } : {}),
      ...(previous ? { previousTurn: previous.turn, previousStep: previous.step } : {}),
      reasons,
    };

    if (unexpectedStableChurn && process.env.MINUS_ASSERT_STABLE_PREFIX === '1') {
      throw new Error(
        `Stable prompt prefix changed outside an allowed boundary (turn=${input.turn} step=${input.step}, `
        + `sections=${report.changedSections.join(',') || 'unknown'}).`,
      );
    }

    this.totals.observations++;
    if (changed) {
      this.totals.changes++;
      if (systemChanged) this.totals.systemChanges++;
      if (toolsChanged) this.totals.toolsChanges++;
      if (turnChanged) this.totals.turnChanges++;
      this.history.push(report);
      if (this.history.length > MAX_PREFIX_CHURN_HISTORY) this.history.shift();
    }

    this.remember(input.sessionId, {
      systemHash,
      toolsHash,
      toolCount: tools.length,
      turn: input.turn,
      step: input.step,
      ...(input.phase ? { phase: input.phase } : {}),
      ...(input.stablePrefixHash !== undefined ? { stablePrefixHash: input.stablePrefixHash } : {}),
      ...(input.sections ? { sections: sectionDigestMap(input.sections) } : {}),
    });
    return report;
  }

  getRecentReports(limit = 10): PromptPrefixChurnReport[] {
    const safeLimit = Math.max(0, Math.min(limit, this.history.length));
    return this.history.slice(this.history.length - safeLimit).map((report) => ({
      ...report,
      reasons: [...report.reasons],
      changedTiers: [...report.changedTiers],
      changedSections: [...report.changedSections],
    }));
  }

  getStats(): PromptPrefixChurnStats {
    return { ...this.totals, trackedSessions: this.lastBySession.size };
  }

  /** Xoá trạng thái của một session (hoặc toàn bộ) khi workspace/session bị thay. */
  reset(sessionId?: string): void {
    if (sessionId === undefined) {
      this.lastBySession.clear();
      this.history.length = 0;
      this.totals.observations = 0;
      this.totals.changes = 0;
      this.totals.systemChanges = 0;
      this.totals.toolsChanges = 0;
      this.totals.turnChanges = 0;
      return;
    }
    this.lastBySession.delete(sessionId);
  }

  private remember(sessionId: string, state: LastPrefix): void {
    this.lastBySession.delete(sessionId);
    this.lastBySession.set(sessionId, state);
    while (this.lastBySession.size > MAX_TRACKED_PREFIX_SESSIONS) {
      const oldest = this.lastBySession.keys().next();
      if (oldest.done) break;
      this.lastBySession.delete(oldest.value);
    }
  }
}
