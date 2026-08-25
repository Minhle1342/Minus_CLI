import { createHash } from 'node:crypto';
import type { Content } from '@google/genai';
import type { SessionEvent } from './session.js';

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
  return createHash('sha256').update(stableStringify(header)).digest('hex');
}

export function computeRequestValueDigest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
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
  let openTurn: number | undefined;
  let openStep: { turn: number; step: number } | undefined;
  const calls = new Map<string, SessionEvent>();
  const results = new Set<string>();
  const requestSteps = new Set<string>();
  let lastTurn = 0;
  const lastStepByTurn = new Map<number, number>();

  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event.seq !== index + 1) throw new Error(`Invariant violation: non-contiguous event seq at ${event.seq}.`);
    if (event.type === 'turn/start') {
      if (openTurn !== undefined) throw new Error(`Invariant violation: turn ${openTurn} was not closed before turn ${event.data.turn}.`);
      if (!event.data.turn || event.data.turn <= lastTurn) throw new Error(`Invariant violation: turn/start ${event.data.turn} is not monotonic.`);
      openTurn = event.data.turn;
      lastTurn = event.data.turn;
    } else if (event.type === 'turn/end') {
      if (openTurn !== event.data.turn) throw new Error(`Invariant violation: turn/end ${event.data.turn} does not match open turn ${openTurn}.`);
      if (openStep) throw new Error(`Invariant violation: turn ${openTurn} ended with step ${openStep.step} still open.`);
      openTurn = undefined;
    } else if (event.type === 'step/start') {
      if (openTurn !== event.data.turn || openStep) throw new Error(`Invariant violation: invalid step/start ${event.data.turn}/${event.data.step}.`);
      const previousStep = lastStepByTurn.get(event.data.turn!) || 0;
      if (!event.data.step || event.data.step !== previousStep + 1) {
        throw new Error(`Invariant violation: step/start ${event.data.turn}/${event.data.step} is not sequential.`);
      }
      openStep = { turn: event.data.turn!, step: event.data.step! };
      lastStepByTurn.set(event.data.turn!, event.data.step!);
    } else if (event.type === 'step/end') {
      if (!openStep || openStep.turn !== event.data.turn || openStep.step !== event.data.step) {
        throw new Error(`Invariant violation: step/end ${event.data.turn}/${event.data.step} has no matching open step.`);
      }
      openStep = undefined;
    } else if (event.type === 'tool/call' && event.data.toolCallId) {
      if (!openStep || event.data.turn !== openStep.turn || event.data.step !== openStep.step) {
        throw new Error(`Invariant violation: tool/call ${event.data.toolCallId} is outside its declared open step.`);
      }
      if (calls.has(event.data.toolCallId)) throw new Error(`Invariant violation: duplicate tool/call id ${event.data.toolCallId}.`);
      calls.set(event.data.toolCallId, event);
    } else if (event.type === 'tool/result' && event.data.toolCallId) {
      if (!calls.has(event.data.toolCallId)) throw new Error(`Invariant violation: orphan tool/result id ${event.data.toolCallId}.`);
      if (results.has(event.data.toolCallId)) throw new Error(`Invariant violation: duplicate tool/result id ${event.data.toolCallId}.`);
      if (event.data.toolName && event.data.toolName !== calls.get(event.data.toolCallId)?.data.toolName) {
        throw new Error(`Invariant violation: tool/result ${event.data.toolCallId} does not match its tool/call name.`);
      }
      results.add(event.data.toolCallId);
    } else if (event.type === 'request/header' && event.data.requestHeader) {
      const { digest, ...withoutDigest } = event.data.requestHeader;
      if (computeRequestDigest(withoutDigest) !== digest) throw new Error(`Invariant violation: request/header digest mismatch at seq ${event.seq}.`);
      if (withoutDigest.sourceEventSeq !== event.seq - 1) throw new Error(`Invariant violation: request/header source boundary mismatch at seq ${event.seq}.`);
      if (!openStep || withoutDigest.turn !== openStep.turn || withoutDigest.step !== openStep.step) {
        throw new Error(`Invariant violation: request/header ${withoutDigest.turn}/${withoutDigest.step} is outside its open step.`);
      }
      const requestStep = `${withoutDigest.turn}:${withoutDigest.step}`;
      if (requestSteps.has(requestStep)) throw new Error(`Invariant violation: duplicate request/header for step ${requestStep}.`);
      requestSteps.add(requestStep);
    }
  }

  if (!options.allowOpenLifecycle && (openTurn !== undefined || openStep)) {
    throw new Error('Invariant violation: session lifecycle is not closed.');
  }
  if (!options.allowPendingToolCalls) {
    for (const callId of calls.keys()) {
      if (!results.has(callId)) throw new Error(`Invariant violation: tool/call ${callId} has no durable result.`);
    }
  }
}
