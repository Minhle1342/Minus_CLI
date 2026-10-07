import { createHash } from 'node:crypto';
import type { Content } from '@google/genai';
import type { SessionEvent } from './session.js';
import { nativeComputeStringHash } from '../native/index.js';

export interface RecordedRequestHeader {
  turn: number;
  step: number;
  systemPrompt: string;
  tools: unknown[];
  /** Legacy exact snapshot. New events use historyDigest to avoid quadratic JSONL growth. */
  history?: Content[];
  historyDigest?: string;
  historyMessages?: number;
  historyCharacters?: number;
  /** Hash-linked chain: digest of the previous request/header event (absent on genesis). */
  previousDigest?: string;
  /**
   * Compaction provenance for this step. Commits the pre-compaction history
   * digest plus archive counts, so a later audit can detect silent archive
   * loss: every masked/archived id must resolve in the memory retriever.
   */
  compaction?: {
    preCompactionHistoryDigest: string;
    preCompactionMessages: number;
    archivedTurns: number;
    maskedObservations: number;
    archiveStatus?: unknown;
  };
  sourceEventSeq: number;
  digest: string;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

export function computeRequestDigest(header: Omit<RecordedRequestHeader, 'digest'>): string {
  return nativeComputeStringHash(stableStringify(header));
}

export function computeRequestValueDigest(value: unknown): string {
  return nativeComputeStringHash(stableStringify(value));
}

export function assertHistoryToolPairing(messages: Content[]): void {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts || []) {
      const callId = (part as any).functionCall?.id;
      if (callId) {
        if (calls.has(callId)) throw new Error(`Invariant violation: duplicate model tool call id ${callId}.`);
        calls.add(callId);
      }
      const resultId = (part as any).functionResponse?.id;
      if (resultId) {
        if (!calls.has(resultId)) throw new Error(`Invariant violation: orphan tool result id ${resultId}.`);
        if (results.has(resultId)) throw new Error(`Invariant violation: duplicate tool result id ${resultId}.`);
        results.add(resultId);
      }
    }
  }
  for (const callId of calls) {
    if (!results.has(callId)) throw new Error(`Invariant violation: tool call ${callId} has no result in projected history.`);
  }
}

export function assertSessionRuntimeInvariants(
  events: SessionEvent[],
  options: { allowOpenLifecycle?: boolean; allowPendingToolCalls?: boolean } = {},
): void {
  const cursor = createInvariantCheckCursor();
  assertSessionRuntimeInvariantsIncremental(events, cursor, options);
}

/**
 * Resumable validator state for long sessions. The event log is append-only,
 * so a Session can verify only the events appended since the last check
 * instead of re-scanning from genesis on every step.
 */
export interface InvariantCheckCursor {
  verifiedSeq: number;
  openTurn?: number;
  openStep?: { turn: number; step: number };
  calls: Map<string, SessionEvent>;
  results: Set<string>;
  requestSteps: Set<string>;
  lastRequestDigest?: string;
  lastTurn: number;
  lastStepByTurn: Map<number, number>;
}

export function createInvariantCheckCursor(): InvariantCheckCursor {
  return {
    verifiedSeq: 0,
    calls: new Map(),
    results: new Set(),
    requestSteps: new Set(),
    lastTurn: 0,
    lastStepByTurn: new Map(),
  };
}

/**
 * Verifies events[cursor.verifiedSeq..] and advances the cursor. Callers must
 * guarantee the already-verified prefix is unchanged (true for Session, whose
 * event log is append-only). Identical semantics to
 * assertSessionRuntimeInvariants for the verified range.
 */
export function assertSessionRuntimeInvariantsIncremental(
  events: SessionEvent[],
  cursor: InvariantCheckCursor,
  options: { allowOpenLifecycle?: boolean; allowPendingToolCalls?: boolean } = {},
): void {
  const start = Math.max(0, Math.min(cursor.verifiedSeq, events.length));
  for (let index = start; index < events.length; index++) {
    const event = events[index];
    if (event.seq !== index + 1) throw new Error(`Invariant violation: non-contiguous event seq at ${event.seq}.`);
    if (event.type === 'turn/start') {
      if (cursor.openTurn !== undefined) throw new Error(`Invariant violation: turn ${cursor.openTurn} was not closed before turn ${event.data.turn}.`);
      if (!event.data.turn || event.data.turn <= cursor.lastTurn) throw new Error(`Invariant violation: turn/start ${event.data.turn} is not monotonic.`);
      cursor.openTurn = event.data.turn;
      cursor.lastTurn = event.data.turn;
    } else if (event.type === 'turn/end') {
      if (cursor.openTurn !== event.data.turn) throw new Error(`Invariant violation: turn/end ${event.data.turn} does not match open turn ${cursor.openTurn}.`);
      if (cursor.openStep) throw new Error(`Invariant violation: turn ${cursor.openTurn} ended with step ${cursor.openStep.step} still open.`);
      cursor.openTurn = undefined;
    } else if (event.type === 'step/start') {
      if (cursor.openTurn !== event.data.turn || cursor.openStep) throw new Error(`Invariant violation: invalid step/start ${event.data.turn}/${event.data.step}.`);
      const previousStep = cursor.lastStepByTurn.get(event.data.turn!) || 0;
      if (!event.data.step || event.data.step !== previousStep + 1) {
        throw new Error(`Invariant violation: step/start ${event.data.turn}/${event.data.step} is not sequential.`);
      }
      cursor.openStep = { turn: event.data.turn!, step: event.data.step! };
      cursor.lastStepByTurn.set(event.data.turn!, event.data.step!);
    } else if (event.type === 'step/end') {
      if (!cursor.openStep || cursor.openStep.turn !== event.data.turn || cursor.openStep.step !== event.data.step) {
        throw new Error(`Invariant violation: step/end ${event.data.turn}/${event.data.step} has no matching open step.`);
      }
      cursor.openStep = undefined;
    } else if (event.type === 'tool/call' && event.data.toolCallId) {
      if (!cursor.openStep || event.data.turn !== cursor.openStep.turn || event.data.step !== cursor.openStep.step) {
        throw new Error(`Invariant violation: tool/call ${event.data.toolCallId} is outside its declared open step.`);
      }
      if (cursor.calls.has(event.data.toolCallId)) throw new Error(`Invariant violation: duplicate tool/call id ${event.data.toolCallId}.`);
      cursor.calls.set(event.data.toolCallId, event);
    } else if (event.type === 'tool/result' && event.data.toolCallId) {
      if (!cursor.calls.has(event.data.toolCallId)) throw new Error(`Invariant violation: orphan tool/result id ${event.data.toolCallId}.`);
      if (cursor.results.has(event.data.toolCallId)) throw new Error(`Invariant violation: duplicate tool/result id ${event.data.toolCallId}.`);
      if (event.data.toolName && event.data.toolName !== cursor.calls.get(event.data.toolCallId)?.data.toolName) {
        throw new Error(`Invariant violation: tool/result ${event.data.toolCallId} does not match its tool/call name.`);
      }
      cursor.results.add(event.data.toolCallId);
    } else if (event.type === 'request/header' && event.data.requestHeader) {
      const { digest, ...withoutDigest } = event.data.requestHeader;
      if (computeRequestDigest(withoutDigest) !== digest) throw new Error(`Invariant violation: request/header digest mismatch at seq ${event.seq}.`);
      if (withoutDigest.sourceEventSeq !== event.seq - 1) throw new Error(`Invariant violation: request/header source boundary mismatch at seq ${event.seq}.`);
      // Hash chain: each header commits to its predecessor. Lenient on legacy
      // headers without previousDigest (written before the chain existed), but
      // any header that claims a predecessor must link exactly.
      if (withoutDigest.previousDigest !== undefined && withoutDigest.previousDigest !== cursor.lastRequestDigest) {
        throw new Error(`Invariant violation: request/header digest chain broken at seq ${event.seq}.`);
      }
      cursor.lastRequestDigest = digest;
      if (!cursor.openStep || withoutDigest.turn !== cursor.openStep.turn || withoutDigest.step !== cursor.openStep.step) {
        throw new Error(`Invariant violation: request/header ${withoutDigest.turn}/${withoutDigest.step} is outside its open step.`);
      }
      const requestStep = `${withoutDigest.turn}:${withoutDigest.step}`;
      if (cursor.requestSteps.has(requestStep)) throw new Error(`Invariant violation: duplicate request/header for step ${requestStep}.`);
      cursor.requestSteps.add(requestStep);
    }
  }
  cursor.verifiedSeq = events.length;

  if (!options.allowOpenLifecycle && (cursor.openTurn !== undefined || cursor.openStep)) {
    throw new Error('Invariant violation: session lifecycle is not closed.');
  }
  if (!options.allowPendingToolCalls) {
    for (const callId of cursor.calls.keys()) {
      if (!cursor.results.has(callId)) throw new Error(`Invariant violation: tool/call ${callId} has no durable result.`);
    }
  }
}
