import type { Content, FunctionDeclaration } from '@google/genai';
import type { TaskPhase } from '../control/classification-types.js';
import type { TokenConfig } from '../llm/token-config.js';

export type ModelLatencyTier = 'fast' | 'standard' | 'deep-reasoning';

export interface ModelLatencyProfile {
  tier: ModelLatencyTier;
  targetMs: number;
  reason: string;
}

export interface LatencyOrchestratorConfig {
  enabled?: boolean;
  softStepTargetMs?: number;
  requestBudgetRatio?: number;
}

export interface RequestFootprint {
  estimatedInputTokens: number;
  historyTokens: number;
  systemPromptTokens: number;
  toolSchemaTokens: number;
  dynamicContextTokens: number;
  nonHistoryTokens: number;
  outputReserveTokens: number;
  usableInputTokens: number;
  pressureRatio: number;
}

export interface ModelLatencyObservation {
  durationMs: number;
  timeToFirstTokenMs?: number;
  promptTokens?: number;
  cachedTokens?: number;
  profile?: ModelLatencyProfile;
}

function serializedLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value).length;
  }
}

function estimateTokensFromCharacters(characters: number): number {
  return Math.ceil(Math.max(0, characters) / 3.8);
}

export function resolveModelLatencyProfile(modelName = '', tokenConfig: TokenConfig = {}): ModelLatencyProfile {
  const normalized = modelName.toLowerCase();
  const explicitDeepReasoning = (tokenConfig.thinkingBudget || 0) > 0
    || tokenConfig.reasoningEffort === 'high'
    || tokenConfig.reasoningEffort === 'max';

  if (explicitDeepReasoning || /(?:thinking|reasoner|deepseek-r1|\br1\b|claude-opus|\bo[134](?:-|\b))/.test(normalized)) {
    return { tier: 'deep-reasoning', targetMs: 60_000, reason: 'thinking/reasoning model profile' };
  }
  if (/(?:^|[-_/])(?:flash|haiku|mini|lite|instant)(?:[-_/]|$)|groq|cerebras/.test(normalized)) {
    return { tier: 'fast', targetMs: 20_000, reason: 'fast/flash model profile' };
  }
  return { tier: 'standard', targetMs: 45_000, reason: 'standard/pro model profile' };
}

/**
 * Provider-neutral soft-latency coordination. It never aborts an in-flight
 * request; it steers the next provider turn using model tier, request pressure,
 * task phase, and already-collected verification evidence.
 */
export class LatencyOrchestrator {
  private readonly config: {
    enabled: boolean;
    softStepTargetMs?: number;
    requestBudgetRatio: number;
  };
  private observations: ModelLatencyObservation[] = [];

  constructor(config: LatencyOrchestratorConfig = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      softStepTargetMs: config.softStepTargetMs === undefined
        ? undefined
        : Math.max(1_000, config.softStepTargetMs),
      requestBudgetRatio: Math.min(0.95, Math.max(0.5, config.requestBudgetRatio ?? 0.82)),
    };
  }

  resetTurn(): void {
    this.observations = [];
  }

  getModelProfile(modelName?: string, tokenConfig?: TokenConfig): ModelLatencyProfile {
    const inferred = resolveModelLatencyProfile(modelName, tokenConfig);
    return this.config.softStepTargetMs === undefined
      ? inferred
      : { ...inferred, targetMs: this.config.softStepTargetMs, reason: `${inferred.reason}; configured override` };
  }

  estimateRequest(input: {
    systemPrompt: string;
    tools: FunctionDeclaration[];
    history: Content[];
    dynamicContext?: string;
    maxInputTokens?: number;
    maxOutputTokens?: number;
  }): RequestFootprint {
    const historyTokens = estimateTokensFromCharacters(serializedLength(input.history));
    const systemPromptTokens = estimateTokensFromCharacters(input.systemPrompt.length);
    const toolSchemaTokens = estimateTokensFromCharacters(serializedLength(input.tools));
    const dynamicContextTokens = estimateTokensFromCharacters(input.dynamicContext?.length || 0);
    const nonHistoryTokens = systemPromptTokens + toolSchemaTokens + dynamicContextTokens;
    const outputReserveTokens = Math.max(0, input.maxOutputTokens || 0);
    const contextWindow = Math.max(1, input.maxInputTokens || 32_000);
    const usableInputTokens = Math.max(1, contextWindow - outputReserveTokens);
    const estimatedInputTokens = historyTokens + nonHistoryTokens;
    return {
      estimatedInputTokens,
      historyTokens,
      systemPromptTokens,
      toolSchemaTokens,
      dynamicContextTokens,
      nonHistoryTokens,
      outputReserveTokens,
      usableInputTokens,
      pressureRatio: estimatedInputTokens / usableInputTokens,
    };
  }

  buildGuidance(input: {
    step: number;
    footprint: RequestFootprint;
    modelName?: string;
    tokenConfig?: TokenConfig;
    phase?: TaskPhase;
    verificationReady?: boolean;
  }): string {
    if (!this.config.enabled) return '';

    const profile = this.getModelProfile(input.modelName, input.tokenConfig);
    const previous = this.observations.at(-1);
    const previousWasSlow = Boolean(previous && previous.durationMs >= profile.targetMs);
    const highPressure = input.footprint.pressureRatio >= this.config.requestBudgetRatio;
    const reasons = [
      `model tier=${profile.tier}, soft target=${Math.round(profile.targetMs / 1000)}s`,
      previousWasSlow && previous ? `previous round trip=${(previous.durationMs / 1000).toFixed(1)}s` : '',
      highPressure ? `request pressure=${(input.footprint.pressureRatio * 100).toFixed(0)}%` : '',
    ].filter(Boolean);

    let phaseDirective: string;
    switch (input.phase) {
      case 'explore':
        phaseDirective = 'Recon: batch independent read-only tools in this response and omit any preamble before tool calls.';
        break;
      case 'plan':
        phaseDirective = 'Plan: use existing evidence, close the smallest remaining uncertainty, and avoid another reconnaissance loop.';
        break;
      case 'implement':
        phaseDirective = 'Action: omit preamble, make one coherent mutation sequence, and keep all mutation/command tools sequential.';
        break;
      case 'verify':
        phaseDirective = input.verificationReady
          ? 'Verification is sufficient: call submit_solution now with the evidence; do not add another model round trip.'
          : 'Verify: run only the decisive missing check, then call submit_solution when the evidence gate is satisfied.';
        break;
      case 'release':
        phaseDirective = 'Release: preserve all safety gates, reuse completed evidence, and avoid repeating successful checks.';
        break;
      default:
        phaseDirective = 'Complete one concrete action now; batch independent reads and do not emit a status-only response.';
    }

    return [
      '[ADAPTIVE SOFT LATENCY COORDINATION — no hard timeout]',
      `Signal: ${reasons.join('; ')}.`,
      phaseDirective,
      'Reuse durable session evidence and keep tool arguments/output concise without weakening correctness or safety.',
    ].join('\n');
  }

  record(observation: ModelLatencyObservation): void {
    if (!this.config.enabled) return;
    this.observations.push({ ...observation });
  }

  getObservations(): ModelLatencyObservation[] {
    return this.observations.map((item) => ({ ...item, profile: item.profile ? { ...item.profile } : undefined }));
  }
}
