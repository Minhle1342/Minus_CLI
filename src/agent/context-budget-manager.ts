import crypto from "node:crypto";
import { resolveRequestBudget } from './request-budget.js';
import type { Content, FunctionDeclaration } from "@google/genai";
import { ExactTokenizer } from "./exact-tokenizer.js";
import {
  ContextCompactor,
  type CompactionOptions,
  type CompactionStats,
  type MaskedObservationRecord,
} from "./context-compactor.js";
import type { ArchivedTurnDocument } from "../context/turn-memory-retriever.js";
import { compactActiveTurnText, type ActiveTextReplacement } from './active-turn-compaction.js';
import { getHistoryTotalChars } from '../session/message-metrics.js';

export type ContextManagementMode = "legacy" | "shadow" | "enforce" | "auto";
export type TokenCountSource =
  "provider" | "tokenizer" | "calibrated" | "conservative";

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
  observe?(
    model: string,
    estimatedInputTokens: number,
    actualInputTokens: number,
  ): void;
}

export interface CompactionEvidenceRef {
  value: string;
  sourceHash: string;
  sourceKind: "history" | "tool-result" | "archive";
}

export interface VerificationEvidenceState {
  command?: string;
  exitCode?: number;
  status: "passed" | "failed" | "unknown";
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
  activeTextReplacements?: ActiveTextReplacement[];
}

export interface ContextPreparationResult {
  mode: ContextManagementMode;
  history: Content[];
  changed: boolean;
  before: RequestTokenCount;
  after: RequestTokenCount;
  candidateAfter?: RequestTokenCount;
  compactionStats?: CompactionStats;
  /** Archive-only checkpoint that intentionally leaves the model history untouched. */
  checkpointObservations?: MaskedObservationRecord[];
  state?: CompactionStateV1;
  withinBudget: boolean;
  phaseTransitionCompacted?: boolean;
  failureReason?: "CONTEXT_BUDGET_UNSATISFIABLE";
}

export interface ContextBudgetManagerOptions {
  mode?: ContextManagementMode;
  triggerRatio?: number;
  counter?: RequestTokenCounter;
}

export interface ContextPrepareOptions extends Omit<
  CompactionOptions,
  "requestOverheadTokens" | "outputReserveTokens" | "modelName"
> {
  previousState?: CompactionStateV1;
  /** UI-only signal, emitted only when candidate compaction actually begins. */
  onCompactionStart?: () => void;
  /** Event-derived turns for recovery; never infer completed turns from message roles. */
  recoveryWindow?: {
    entries: import('./context-compactor.js').TurnWindowEntry[];
    completedTurns: number[];
    openTurn?: number;
  };
  /** Consider an early compaction at a durable phase boundary only when savings justify losing the cache prefix. */
  phaseTransition?: { minHistoryTokens?: number; minSavingsTokens?: number; minSavingsRatio?: number };
}

export function resolveContextManagementMode(
  value?: string,
): ContextManagementMode {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "legacy" ||
    normalized === "shadow" ||
    normalized === "enforce" ||
    normalized === "auto"
  ) {
    return normalized;
  }
  return "auto";
}

const KNOWN_PROVIDERS = new Set([
  "gemini",
  "google",
  "vertex",
  "openai",
  "gpt",
  "anthropic",
  "claude",
  "groq",
  "cerebras",
  "sambanova",
  "mistral",
  "cohere",
  "deepseek",
  "xai",
  "grok",
]);

function isKnownProvider(provider: string): boolean {
  const lower = provider.toLowerCase();
  return (
    KNOWN_PROVIDERS.has(lower) ||
    lower.includes("gemini") ||
    lower.includes("gpt") ||
    lower.includes("claude")
  );
}

function resolveAutoMode(provider: string): "legacy" | "enforce" {
  return isKnownProvider(provider) ? "enforce" : "legacy";
}

/**
 * Provider-neutral counter over the exact request envelope. It deliberately
 * reports an uncertainty margin because ExactTokenizer is an estimator for
 * providers whose native preflight endpoint is unavailable.
 */
export class CalibratedRequestTokenCounter implements RequestTokenCounter {
  private readonly observedRatios = new Map<string, number[]>();

  async count(envelope: ModelRequestEnvelope): Promise<RequestTokenCount> {
    const historyTokens = ContextCompactor.countHistoryTokens(
      envelope.history,
      envelope.model,
    );
    const staticText = JSON.stringify({
      systemPrompt: envelope.systemPrompt,
      tools: envelope.tools,
      dynamicContext: envelope.dynamicContext || "",
    });
    const nonHistoryTokens = ExactTokenizer.countTokens(
      staticText,
      envelope.model,
    );
    const inputTokens = historyTokens + nonHistoryTokens;
    const ratios = this.observedRatios.get(envelope.model.toLowerCase()) || [];
    let calibratedRatio = 1.0;
    if (ratios.length > 0) {
      const validRatios = ratios.filter(
        (r) => Number.isFinite(r) && r >= 0.5 && r <= 2.5,
      );
      if (validRatios.length > 0) {
        const sorted = [...validRatios].sort((a, b) => a - b);
        const p90Index = Math.min(
          sorted.length - 1,
          Math.floor(sorted.length * 0.9),
        );
        calibratedRatio = sorted[p90Index];
      }
    }
    // Apply the observed systematic bias to the estimate itself, then keep a
    // bounded uncertainty margin around that calibrated baseline. Previously
    // only the margin used the observation (capped at +20%), so a steady 1.8x
    // undercount kept reporting ~1.2x upper bounds.
    const calibratedHistoryTokens = Math.ceil(historyTokens * calibratedRatio);
    const calibratedNonHistoryTokens = Math.ceil(nonHistoryTokens * calibratedRatio);
    const calibratedInputTokens = calibratedHistoryTokens + calibratedNonHistoryTokens;
    // Giới hạn sai số biên an toàn trong khoảng [0.05, 0.20] (tối đa 20% margin, không bùng nổ do outlier)
    const errorMarginRatio = Math.min(
      0.2,
      Math.max(0.05, calibratedRatio * 1.05 - 1),
    );
    return {
      inputTokens: calibratedInputTokens,
      upperBoundTokens: Math.ceil(calibratedInputTokens * (1 + errorMarginRatio)),
      historyTokens: calibratedHistoryTokens,
      nonHistoryTokens: calibratedNonHistoryTokens,
      source: ratios.length > 0 ? "calibrated" : "tokenizer",
      hardBound: false,
      errorMarginRatio,
    };
  }

  observe(
    model: string,
    estimatedInputTokens: number,
    actualInputTokens: number,
  ): void {
    if (estimatedInputTokens <= 0 || actualInputTokens <= 0) return;
    const ratio = actualInputTokens / estimatedInputTokens;
    // Bỏ qua các outlier bất thường do turn rỗng, lệch cache hoặc chênh lệch snapshot
    if (!Number.isFinite(ratio) || ratio < 0.5 || ratio > 2.5) return;
    const key = model.toLowerCase();
    const ratios = this.observedRatios.get(key) || [];
    ratios.push(ratio);
    if (ratios.length > 100) ratios.splice(0, ratios.length - 100);
    this.observedRatios.set(key, ratios);
  }
}

function textParts(history: Content[]): string[] {
  return history
    .flatMap((message) => message.parts || [])
    .map((part: any) => (typeof part.text === "string" ? part.text.trim() : ""))
    .filter(Boolean);
}

function evidence(
  value: string,
  sourceKind: CompactionEvidenceRef["sourceKind"],
): CompactionEvidenceRef {
  return {
    value,
    sourceKind,
    sourceHash: crypto
      .createHash("sha256")
      .update(value)
      .digest("hex")
      .slice(0, 16),
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
  const decisions = archived.flatMap(
    (turn: ArchivedTurnDocument) => turn.keyDecisions || [],
  );
  const files = [
    ...archived.flatMap(
      (turn: ArchivedTurnDocument) => turn.filesTouched || [],
    ),
    ...masked.map((item: MaskedObservationRecord) => item.targetPath || ""),
  ].filter(Boolean);
  const verification: VerificationEvidenceState[] = [];
  const commandCalls = new Map<string, string>();

  for (const message of history) {
    for (const part of message.parts || []) {
      const call = (part as any).functionCall as
        { id?: string; name?: string; args?: Record<string, any> } | undefined;
      if (call?.id && call.name === "run_command") {
        const command =
          typeof call.args?.command === "string"
            ? call.args.command.trim()
            : "";
        if (command) commandCalls.set(call.id, command);
      }
      const response = (part as any).functionResponse?.response as
        Record<string, any> | undefined;
      if (!response) continue;
      const responseId = String((part as any).functionResponse?.id || "");
      const command =
        commandCalls.get(responseId) ||
        (typeof response.command === "string" ? response.command : undefined);
      const exitCode =
        typeof response.exitCode === "number" ? response.exitCode : undefined;
      const succeeded = response.success === true || exitCode === 0;
      const failed =
        response.success === false ||
        (exitCode !== undefined && exitCode !== 0);
      if (!command || (!succeeded && !failed)) continue;
      const serialized = JSON.stringify({
        responseId,
        command,
        exitCode,
        success: response.success,
      });
      verification.push({
        command,
        exitCode,
        status: succeeded ? "passed" : "failed",
        sourceHash: crypto
          .createHash("sha256")
          .update(serialized)
          .digest("hex")
          .slice(0, 16),
      });
    }
  }

  const newDecisionRefs = Array.from(new Set(decisions))
    .slice(0, 20)
    .map((value) => evidence(value, "archive"));
  const newFileRefs = Array.from(new Set(files))
    .slice(0, 50)
    .map((value) => evidence(value, "archive"));
  const mergeRefs = (
    older: CompactionEvidenceRef[] = [],
    newer: CompactionEvidenceRef[] = [],
    limit: number,
  ) => {
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
    sourceFingerprint: crypto
      .createHash("sha256")
      .update(JSON.stringify(history))
      .digest("hex"),
    objective:
      previous?.objective ||
      (texts[0] ? evidence(texts[0].slice(0, 1_000), "history") : undefined),
    decisions: mergeRefs(previous?.decisions, newDecisionRefs, 20),
    files: mergeRefs(previous?.files, newFileRefs, 50),
    verification: Array.from(verificationByHash.values()).slice(-20),
    archivedTurnIds: Array.from(
      new Set([
        ...(previous?.archivedTurnIds || []),
        ...archived.map((turn) => turn.id),
      ]),
    ),
    maskedObservationIds: Array.from(
      new Set([
        ...(previous?.maskedObservationIds || []),
        ...masked.map((item) => item.id),
      ]),
    ),
  };
}

export class ContextBudgetManager {
  private rejectedCandidateKeys = new Set<string>();
  private markRejectedCandidate(key: string, limit = 5): void {
    this.rejectedCandidateKeys.add(key);
    while (this.rejectedCandidateKeys.size > limit) {
      const oldest = this.rejectedCandidateKeys.values().next();
      if (oldest.done) break;
      this.rejectedCandidateKeys.delete(oldest.value);
    }
  }
  private clearRejectedCandidates(): void {
    this.rejectedCandidateKeys.clear();
  }
  readonly mode: ContextManagementMode;
  readonly triggerRatio: number;
  readonly counter: RequestTokenCounter;

  constructor(
    private readonly compactor: ContextCompactor,
    options: ContextBudgetManagerOptions = {},
  ) {
    this.mode = options.mode || "auto";
    this.triggerRatio = Math.min(
      0.95,
      Math.max(0.5, options.triggerRatio ?? 0.75),
    );
    this.counter = options.counter || new CalibratedRequestTokenCounter();
  }

  async prepareRequest(
    envelope: ModelRequestEnvelope,
    options: ContextPrepareOptions = {},
  ): Promise<ContextPreparationResult> {
    const before = await this.counter.count(envelope);
    const { usableInputTokens, targetUsableInputTokens } = resolveRequestBudget(envelope);
    const budgetPressure =
      before.upperBoundTokens >
      Math.floor(targetUsableInputTokens * this.triggerRatio);
    const phaseTransitionEligible = Boolean((this.mode === "enforce"
      || (this.mode === "auto" && isKnownProvider(envelope.provider)))
      && options.phaseTransition
      && before.historyTokens >= (options.phaseTransition.minHistoryTokens ?? 4_000));
    const shouldCompact = budgetPressure || phaseTransitionEligible;
    const checkpointObservations = this.compactor.collectWithinTurnCheckpoint(
      envelope.history,
    );

    if (!shouldCompact) {
      return {
        mode: this.mode,
        history: envelope.history,
        changed: false,
        before,
        after: before,
        checkpointObservations,
        withinBudget: before.upperBoundTokens <= usableInputTokens,
      };
    }

    // A bounded, content-based negative cache. Recount the request first so a
    // calibration/budget/config/pinning change cannot reuse an obsolete verdict.
    const candidateKey = crypto.createHash('sha256').update(JSON.stringify({
      envelope, options: { ...options, onCompactionStart: undefined },
      config: this.compactor.getConfig(), count: before, mode: this.mode,
    })).digest('hex');
    if (this.rejectedCandidateKeys.has(candidateKey)) {
      const enforce = this.mode === 'enforce' || (this.mode === 'auto' && isKnownProvider(envelope.provider));
      return { mode: this.mode, history: envelope.history, changed: false,
        before, after: before, checkpointObservations,
        withinBudget: before.upperBoundTokens <= usableInputTokens,
        ...(enforce && before.upperBoundTokens > usableInputTokens
          ? { failureReason: 'CONTEXT_BUDGET_UNSATISFIABLE' as const } : {}) };
    }
    options.onCompactionStart?.();
    const { previousState, phaseTransition, onCompactionStart, recoveryWindow, ...compactionOptions } = options;
    const baseOptions: CompactionOptions = {
      ...compactionOptions,
      force: true,
      requestOverheadTokens: before.nonHistoryTokens,
      outputReserveTokens: envelope.outputReserveTokens,
      triggerRatio: 1,
      modelName: envelope.model,
      maxInputTokens: Math.max(
        1,
        Math.floor(targetUsableInputTokens / (1 + before.errorMarginRatio)) +
          envelope.outputReserveTokens,
      ),
    };

    // Resolve effective mode for this request (handles 'auto')
    const effectiveMode =
      this.mode === "auto" ? resolveAutoMode(envelope.provider) : this.mode;
    const useEnforce = effectiveMode === "enforce";
    const useLegacy = effectiveMode === "legacy";

    const legacy = !useEnforce
      ? this.compactor.compact(envelope.history, baseOptions)
      : undefined;
    const candidate = !useLegacy
      ? this.compactor.compact(envelope.history, {
          ...baseOptions,
          enforceBudget: true,
        })
      : undefined;
    const selected = (useEnforce ? candidate! : legacy!) || candidate || legacy;
    const selectedEnvelope = { ...envelope, history: selected.messages };
    const after = await this.counter.count(selectedEnvelope);
    const phaseSavings = before.historyTokens - after.historyTokens;
    const minimumPhaseSavings = Math.max(
      phaseTransition?.minSavingsTokens ?? 768,
      Math.ceil(before.historyTokens * (phaseTransition?.minSavingsRatio ?? 0.2)),
    );
    if (!budgetPressure && phaseSavings < minimumPhaseSavings) {
      this.markRejectedCandidate(candidateKey);
      return {
        mode: this.mode,
        history: envelope.history,
        changed: false,
        before,
        after: before,
        checkpointObservations,
        withinBudget: before.upperBoundTokens <= usableInputTokens,
      };
    }
    const candidateAfter =
      this.mode === "shadow" && candidate
        ? await this.counter.count({ ...envelope, history: candidate.messages })
        : undefined;
    let finalSelected = selected;
    let finalAfter = after;
    let withinBudget = after.upperBoundTokens <= usableInputTokens;

    // Emergency Deep Compaction: Nếu vẫn vượt ngân sách cấu hình và có nhiều hơn 2 tin nhắn,
    // tự động ép sâu hơn (chỉ giữ 2 turn gần nhất và mask toàn bộ kết quả tool cũ) trước khi báo lỗi.
    if (!withinBudget && ((!options.protectActiveTurn && envelope.history.length > 2) || (useEnforce && options.protectActiveTurn && recoveryWindow))) {
      const emergencyBudgetTokens = Math.max(
        1,
        usableInputTokens - before.nonHistoryTokens,
      );
      let emergencyCandidate = recoveryWindow && options.protectActiveTurn
        ? this.compactor.compactCompletedTurnWindow(recoveryWindow.entries, {
          completedTurns: recoveryWindow.completedTurns, openTurn: recoveryWindow.openTurn,
          preserveCompletedTurns: 1, plan: options.plan,
        })
        : this.compactor.compact(selected.messages, {
        ...baseOptions,
        enforceBudget: true,
        maxInputTokens: Math.max(
          1,
          emergencyBudgetTokens + envelope.outputReserveTokens,
        ),
        enableRollingTurns: true,
        preserveLastNTurns: 2,
        enableObservationMasking: true,
      });
      if (recoveryWindow && options.protectActiveTurn) {
        const count = await this.counter.count({ ...envelope, history: emergencyCandidate.messages });
        if (count.upperBoundTokens > usableInputTokens) {
          emergencyCandidate = this.compactor.compactCompletedTurnWindow(recoveryWindow.entries, {
            completedTurns: recoveryWindow.completedTurns, openTurn: recoveryWindow.openTurn,
            preserveCompletedTurns: 0, plan: options.plan,
          });
        }
      }
      if (emergencyCandidate.stats.charsSaved > 0) {
        const emergencyEnvelope = {
          ...envelope,
          history: emergencyCandidate.messages,
        };
        const emergencyAfter = await this.counter.count(emergencyEnvelope);
        if (
          emergencyAfter.upperBoundTokens <= usableInputTokens ||
          emergencyAfter.upperBoundTokens < finalAfter.upperBoundTokens
        ) {
          // Preserve first-pass archives: emergency runs on already-compacted
          // messages, so its stats alone omit earlier archived turns/masks.
          // Union by stable ID, preferring the full original payload.
          const mergedArchivedById = new Map<string, NonNullable<typeof selected.stats.archivedTurns>[number]>();
          for (const turn of [...(selected.stats.archivedTurns || []), ...(emergencyCandidate.stats.archivedTurns || [])]) {
            if (turn && !mergedArchivedById.has(turn.id)) mergedArchivedById.set(turn.id, turn);
          }
          const mergedMaskedById = new Map<string, NonNullable<typeof selected.stats.maskedObservations>[number]>();
          const preferFull = (existing: { originalPayload?: unknown }, incoming: { originalPayload?: unknown }) => {
            const sizeOf = (p: unknown) => {
              try { return JSON.stringify(p ?? '').length; } catch { return 0; }
            };
            return sizeOf(incoming.originalPayload) > sizeOf(existing.originalPayload) ? incoming : existing;
          };
          for (const rec of [...(selected.stats.maskedObservations || []), ...(emergencyCandidate.stats.maskedObservations || [])]) {
            if (!rec) continue;
            const prev = mergedMaskedById.get(rec.id);
            mergedMaskedById.set(rec.id, prev ? preferFull(prev, rec) as typeof prev : rec);
          }
          const mergedArchivedTurns = Array.from(mergedArchivedById.values());
          const mergedMasked = Array.from(mergedMaskedById.values());
          const mergedStrategies = Array.from(new Set([
            ...(selected.stats.strategiesApplied || []),
            ...(emergencyCandidate.stats.strategiesApplied || []),
          ]));
          finalSelected = {
            messages: emergencyCandidate.messages,
            stats: {
              ...emergencyCandidate.stats,
              originalTokens: selected.stats.originalTokens,
              originalLength: selected.stats.originalLength,
              compactedTokens: emergencyCandidate.stats.compactedTokens,
              tokensSaved: Math.max(0, selected.stats.originalTokens - emergencyCandidate.stats.compactedTokens),
              compactedLength: emergencyCandidate.stats.compactedLength,
              charsSaved: Math.max(0, selected.stats.originalLength - emergencyCandidate.stats.compactedLength),
              prunedPartsCount: (selected.stats.prunedPartsCount || 0) + (emergencyCandidate.stats.prunedPartsCount || 0),
              prunedTurnsCount: (selected.stats.prunedTurnsCount || 0) + (emergencyCandidate.stats.prunedTurnsCount || 0),
              archivedTurns: mergedArchivedTurns as typeof emergencyCandidate.stats.archivedTurns,
              maskedObservations: mergedMasked as typeof emergencyCandidate.stats.maskedObservations,
              strategiesApplied: [...mergedStrategies, 'emergency-archive-union'],
            },
          };
          finalAfter = emergencyAfter;
          withinBudget = emergencyAfter.upperBoundTokens <= usableInputTokens;
        }
      }
    }

    let activeTextReplacements: ActiveTextReplacement[] = [];
    if (!withinBudget && useEnforce && options.protectActiveTurn && recoveryWindow) {
      const reduced = compactActiveTurnText(finalSelected.messages, recoveryWindow.entries, recoveryWindow.openTurn);
      if (reduced.replacements.length > 0) {
        const reducedCount = await this.counter.count({ ...envelope, history: reduced.messages });
        if (reducedCount.upperBoundTokens < finalAfter.upperBoundTokens) {
          activeTextReplacements = reduced.replacements;
          finalSelected = { messages: reduced.messages, stats: { ...finalSelected.stats,
            compactedLength: getHistoryTotalChars(reduced.messages),
            compactedTokens: ContextCompactor.countHistoryTokens(reduced.messages, envelope.model),
            charsSaved: Math.max(0, getHistoryTotalChars(envelope.history) - getHistoryTotalChars(reduced.messages)),
            maskedObservations: [...(finalSelected.stats.maskedObservations || []), ...reduced.archives],
            strategiesApplied: [...finalSelected.stats.strategiesApplied, 'active-turn-assistant-text-compaction'],
          } };
          finalAfter = reducedCount;
          withinBudget = reducedCount.upperBoundTokens <= usableInputTokens;
          finalSelected.stats.tokensSaved = before.upperBoundTokens - finalAfter.upperBoundTokens;
          finalSelected.stats.withinBudget = withinBudget;
          finalSelected.stats.budgetOverflowTokens = Math.max(0, finalAfter.upperBoundTokens - usableInputTokens);
        }
      }
    }
    const tokensSaved = before.upperBoundTokens - finalAfter.upperBoundTokens;
    const materialSavings = tokensSaved >= 512 && tokensSaved / Math.max(1, before.upperBoundTokens) >= 0.1;
    if (tokensSaved <= 0 || (before.upperBoundTokens <= usableInputTokens && !materialSavings)) {
      this.markRejectedCandidate(candidateKey);
      return {
        mode: this.mode, history: envelope.history, changed: false,
        before, after: before, checkpointObservations,
        compactionStats: finalSelected.stats,
        withinBudget: before.upperBoundTokens <= usableInputTokens,
        ...(effectiveMode === 'enforce' && before.upperBoundTokens > usableInputTokens
          ? { failureReason: 'CONTEXT_BUDGET_UNSATISFIABLE' as const } : {}),
      };
    }
    this.clearRejectedCandidates();
    return {
      mode: this.mode,
      history: finalSelected.messages,
      changed: finalSelected.stats.charsSaved > 0 && finalAfter.upperBoundTokens < before.upperBoundTokens,
      before,
      after: finalAfter,
      candidateAfter,
      compactionStats: finalSelected.stats,
      checkpointObservations,
      state: { ...buildState(
        finalSelected.messages,
        finalSelected.stats,
        previousState,
      ), ...(activeTextReplacements.length ? { activeTextReplacements } : {}) },
      withinBudget,
      phaseTransitionCompacted: phaseTransitionEligible && !budgetPressure,
      ...(effectiveMode === "enforce" && !withinBudget
        ? { failureReason: "CONTEXT_BUDGET_UNSATISFIABLE" as const }
        : {}),
    };
  }

  observeActualUsage(
    model: string,
    estimatedInputTokens: number,
    actualInputTokens?: number,
  ): void {
    if (actualInputTokens === undefined) return;
    this.counter.observe?.(model, estimatedInputTokens, actualInputTokens);
  }
}
