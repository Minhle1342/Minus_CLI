import crypto from 'node:crypto';
import type { Content, FunctionDeclaration } from '@google/genai';
import { ExactTokenizer } from './exact-tokenizer.js';
import {
  ContextCompactor,
  type CompactionOptions,
  type CompactionStats,
  type MaskedObservationRecord,
} from './context-compactor.js';
import type { ArchivedTurnDocument } from '../context/turn-memory-retriever.js';

export type ContextManagementMode = 'legacy' | 'shadow' | 'enforce';
export type TokenCountSource = 'provider' | 'tokenizer' | 'calibrated' | 'conservative';

export interface ModelRequestEnvelope {
  provider: string;
  model: string;
  systemPrompt: string;
  tools: FunctionDeclaration[];
  history: Content[];
  dynamicContext?: string;
  maxInputTokens: number;
  /** Optional proactive cost ceiling. Failure is based on maxInputTokens, not this target. */
  targetInputTokens?: number;
  outputReserveTokens: number;
}

export interface RequestTokenCount {
  inputTokens: number;
  upperBoundTokens: number;
  historyTokens: number;
  nonHistoryTokens: number;
  source: TokenCountSource;
  hardBound: boolean;
  errorMarginRatio: number;
}

export interface RequestTokenCounter {
  count(envelope: ModelRequestEnvelope): Promise<RequestTokenCount>;
  observe?(model: string, estimatedInputTokens: number, actualInputTokens: number): void;
}

export interface CompactionEvidenceRef {
  value: string;
  sourceHash: string;
  sourceKind: 'history' | 'tool-result' | 'archive';
}

export interface VerificationEvidenceState {
  command?: string;
  exitCode?: number;
  status: 'passed' | 'failed' | 'unknown';
  sourceHash: string;
}

export interface CompactionStateV1 {
  schemaVersion: 1;
  generation: number;
  sourceFingerprint: string;
  objective?: CompactionEvidenceRef;
  decisions: CompactionEvidenceRef[];
  files: CompactionEvidenceRef[];
  verification: VerificationEvidenceState[];
  archivedTurnIds: string[];
  maskedObservationIds: string[];
}

export interface ContextPreparationResult {
  mode: ContextManagementMode;
  history: Content[];
  changed: boolean;
  before: RequestTokenCount;
  after: RequestTokenCount;
  candidateAfter?: RequestTokenCount;
  compactionStats?: CompactionStats;
  state?: CompactionStateV1;
  withinBudget: boolean;
  failureReason?: 'CONTEXT_BUDGET_UNSATISFIABLE';
}

export interface ContextBudgetManagerOptions {
  mode?: ContextManagementMode;
  triggerRatio?: number;
  counter?: RequestTokenCounter;
}

export interface ContextPrepareOptions extends Omit<CompactionOptions, 'requestOverheadTokens' | 'outputReserveTokens' | 'modelName'> {
  previousState?: CompactionStateV1;
}

export function resolveContextManagementMode(value?: string): ContextManagementMode {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'shadow' || normalized === 'enforce' ? normalized : 'legacy';
}

/**
 * Provider-neutral counter over the exact request envelope. It deliberately
 * reports an uncertainty margin because ExactTokenizer is an estimator for
 * providers whose native preflight endpoint is unavailable.
 */
export class CalibratedRequestTokenCounter implements RequestTokenCounter {
  private readonly observedRatios = new Map<string, number[]>();

  async count(envelope: ModelRequestEnvelope): Promise<RequestTokenCount> {
    const historyTokens = ContextCompactor.countHistoryTokens(envelope.history, envelope.model);
    const staticText = JSON.stringify({
      systemPrompt: envelope.systemPrompt,
      tools: envelope.tools,
      dynamicContext: envelope.dynamicContext || '',
    });
    const nonHistoryTokens = ExactTokenizer.countTokens(staticText, envelope.model);
    const inputTokens = historyTokens + nonHistoryTokens;
    const ratios = this.observedRatios.get(envelope.model.toLowerCase()) || [];
    const observedMax = ratios.length > 0 ? Math.max(...ratios) : 1;
    const errorMarginRatio = Math.max(0.05, observedMax * 1.05 - 1);
    return {
      inputTokens,
      upperBoundTokens: Math.ceil(inputTokens * (1 + errorMarginRatio)),
      historyTokens,
      nonHistoryTokens,
      source: ratios.length > 0 ? 'calibrated' : 'tokenizer',
      hardBound: false,
      errorMarginRatio,
    };
  }

  observe(model: string, estimatedInputTokens: number, actualInputTokens: number): void {
    if (estimatedInputTokens <= 0 || actualInputTokens <= 0) return;
    const key = model.toLowerCase();
    const ratios = this.observedRatios.get(key) || [];
    ratios.push(actualInputTokens / estimatedInputTokens);
    if (ratios.length > 200) ratios.splice(0, ratios.length - 200);
    this.observedRatios.set(key, ratios);
  }
}

function textParts(history: Content[]): string[] {
  return history.flatMap((message) => (message.parts || []))
    .map((part: any) => typeof part.text === 'string' ? part.text.trim() : '')
    .filter(Boolean);
}

function evidence(value: string, sourceKind: CompactionEvidenceRef['sourceKind']): CompactionEvidenceRef {
  return {
    value,
    sourceKind,
    sourceHash: crypto.createHash('sha256').update(value).digest('hex').slice(0, 16),
  };
}

function buildState(
  history: Content[],
  stats: CompactionStats,
  previous?: CompactionStateV1,
): CompactionStateV1 {
  const texts = textParts(history);
  const archived = stats.archivedTurns || [];
  const masked = stats.maskedObservations || [];
  const decisions = archived.flatMap((turn: ArchivedTurnDocument) => turn.keyDecisions || []);
  const files = [
    ...archived.flatMap((turn: ArchivedTurnDocument) => turn.filesTouched || []),
    ...masked.map((item: MaskedObservationRecord) => item.targetPath || ''),
  ].filter(Boolean);
  const verification: VerificationEvidenceState[] = [];
  const commandCalls = new Map<string, string>();

  for (const message of history) {
    for (const part of message.parts || []) {
      const call = (part as any).functionCall as { id?: string; name?: string; args?: Record<string, any> } | undefined;
      if (call?.id && call.name === 'run_command') {
        const command = typeof call.args?.command === 'string' ? call.args.command.trim() : '';
        if (command) commandCalls.set(call.id, command);
      }
      const response = (part as any).functionResponse?.response as Record<string, any> | undefined;
      if (!response) continue;
      const responseId = String((part as any).functionResponse?.id || '');
      const command = commandCalls.get(responseId)
        || (typeof response.command === 'string' ? response.command : undefined);
      const exitCode = typeof response.exitCode === 'number' ? response.exitCode : undefined;
      const succeeded = response.success === true || exitCode === 0;
      const failed = response.success === false || (exitCode !== undefined && exitCode !== 0);
      if (!command || (!succeeded && !failed)) continue;
      const serialized = JSON.stringify({ responseId, command, exitCode, success: response.success });
      verification.push({
        command,
        exitCode,
        status: succeeded ? 'passed' : 'failed',
        sourceHash: crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 16),
      });
    }
  }

  const newDecisionRefs = Array.from(new Set(decisions)).slice(0, 20).map((value) => evidence(value, 'archive'));
  const newFileRefs = Array.from(new Set(files)).slice(0, 50).map((value) => evidence(value, 'archive'));
  const mergeRefs = (older: CompactionEvidenceRef[] = [], newer: CompactionEvidenceRef[] = [], limit: number) => {
    const byHash = new Map<string, CompactionEvidenceRef>();
    for (const item of [...older, ...newer]) byHash.set(item.sourceHash, item);
    return Array.from(byHash.values()).slice(-limit);
  };
  const verificationByHash = new Map<string, VerificationEvidenceState>();
  for (const item of [...(previous?.verification || []), ...verification]) {
    verificationByHash.set(item.sourceHash, item);
  }

  return {
    schemaVersion: 1,
    generation: (previous?.generation || 0) + 1,
    sourceFingerprint: crypto.createHash('sha256').update(JSON.stringify(history)).digest('hex'),
    objective: previous?.objective || (texts[0] ? evidence(texts[0].slice(0, 1_000), 'history') : undefined),
    decisions: mergeRefs(previous?.decisions, newDecisionRefs, 20),
    files: mergeRefs(previous?.files, newFileRefs, 50),
    verification: Array.from(verificationByHash.values()).slice(-20),
    archivedTurnIds: Array.from(new Set([...(previous?.archivedTurnIds || []), ...archived.map((turn) => turn.id)])),
    maskedObservationIds: Array.from(new Set([...(previous?.maskedObservationIds || []), ...masked.map((item) => item.id)])),
  };
}

export class ContextBudgetManager {
  readonly mode: ContextManagementMode;
  readonly triggerRatio: number;
  readonly counter: RequestTokenCounter;

  constructor(
    private readonly compactor: ContextCompactor,
    options: ContextBudgetManagerOptions = {},
  ) {
    this.mode = options.mode || 'legacy';
    this.triggerRatio = Math.min(0.95, Math.max(0.5, options.triggerRatio ?? 0.75));
    this.counter = options.counter || new CalibratedRequestTokenCounter();
  }

  async prepareRequest(
    envelope: ModelRequestEnvelope,
    options: ContextPrepareOptions = {},
  ): Promise<ContextPreparationResult> {
    const before = await this.counter.count(envelope);
    const usableInputTokens = Math.max(0, envelope.maxInputTokens - envelope.outputReserveTokens);
    const targetInputTokens = Math.min(
      envelope.maxInputTokens,
      Math.max(1, envelope.targetInputTokens ?? envelope.maxInputTokens),
    );
    const targetUsableInputTokens = Math.max(0, targetInputTokens - envelope.outputReserveTokens);
    const shouldCompact = before.upperBoundTokens > Math.floor(targetUsableInputTokens * this.triggerRatio);

    if (!shouldCompact) {
      return {
        mode: this.mode,
        history: envelope.history,
        changed: false,
        before,
        after: before,
        withinBudget: before.upperBoundTokens <= usableInputTokens,
      };
    }

    const { previousState, ...compactionOptions } = options;
    const baseOptions: CompactionOptions = {
      ...compactionOptions,
      force: true,
      requestOverheadTokens: before.nonHistoryTokens,
      outputReserveTokens: envelope.outputReserveTokens,
      triggerRatio: 1,
      modelName: envelope.model,
      maxInputTokens: Math.max(
        1,
        Math.floor(targetUsableInputTokens / (1 + before.errorMarginRatio)) + envelope.outputReserveTokens,
      ),
    };
    const legacy = this.compactor.compact(envelope.history, baseOptions);
    const candidate = this.compactor.compact(envelope.history, { ...baseOptions, enforceBudget: true });
    const selected = this.mode === 'enforce' ? candidate : legacy;
    const selectedEnvelope = { ...envelope, history: selected.messages };
    const after = await this.counter.count(selectedEnvelope);
    const candidateAfter = this.mode === 'shadow'
      ? await this.counter.count({ ...envelope, history: candidate.messages })
      : undefined;
    const withinBudget = after.upperBoundTokens <= usableInputTokens;

    return {
      mode: this.mode,
      history: selected.messages,
      changed: selected.stats.charsSaved > 0,
      before,
      after,
      candidateAfter,
      compactionStats: selected.stats,
      state: buildState(selected.messages, selected.stats, previousState),
      withinBudget,
      ...(this.mode === 'enforce' && !withinBudget
        ? { failureReason: 'CONTEXT_BUDGET_UNSATISFIABLE' as const }
        : {}),
    };
  }

  observeActualUsage(model: string, estimatedInputTokens: number, actualInputTokens?: number): void {
    if (actualInputTokens === undefined) return;
    this.counter.observe?.(model, estimatedInputTokens, actualInputTokens);
  }
}
