import type { Content, FunctionCall } from '@google/genai';
import type { MemoryRecord } from '../memory/types.js';
import type { SkillActivationDecision } from '../skills/types.js';

export type SessionMessage = Content;
export type ContentPart = any;

export type SessionEventType =
  | 'user/message'
  | 'assistant/message'
  | 'tool/result'
  | 'turn/start'
  | 'turn/end'
  | 'step/start'
  | 'step/end'
  | 'tool/call'
  | 'plan/change'
  | 'goal/change'
  | 'memory/change'
  | 'input/queued'
  | 'input/claimed'
  | 'agent/delegation'
  | 'effect/change'
  | 'skill/change'
  | 'session/fork'
  | 'session/compaction';

export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete';

export interface GoalState {
  id: string;
  revision: number;
  objective: string;
  phase: GoalPhase;
  roundsStarted: number;
  maxRounds: number;
  blocker?: string;
  createdAt: string;
  updatedAt: string;
}

export type DelegationStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface DelegationState {
  id: string;
  sessionId: string;
  objective: string;
  status: DelegationStatus;
  answer?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export type EffectStatus = 'prepared' | 'committed' | 'failed' | 'rolledback';
export type EffectOutcome = 'success' | 'error' | 'unknown';

export interface EffectState {
  id: string;
  toolName: string;
  toolCallId?: string;
  status: EffectStatus;
  outcome?: EffectOutcome;
  reversible: boolean;
  checkpointId?: string;
  preparedAt: string;
  completedAt?: string;
  reason?: string;
}

export interface SessionEventData {
  content?: Content;
  messages?: Content[];
  source?: 'human' | 'system' | 'injected';
  inputId?: string;
  inputText?: string;
  parentSessionId?: string;
  boundarySeq?: number;
  reason?: string;
  turn?: number;
  step?: number;
  toolName?: string;
  toolCallId?: string;
  assistantSeq?: number;
  thoughtSignature?: string;
  args?: Record<string, any>;
  result?: Record<string, any>;
  plan?: Array<{ id: number; title: string; status: string; notes?: string }>;
  goal?: GoalState | null;
  memory?: MemoryRecord | null;
  delegation?: DelegationState | null;
  effect?: EffectState | null;
  skill?: SkillActivationDecision | null;
}

export interface SessionEvent {
  seq: number;
  id: string;
  type: SessionEventType;
  createdAt: string;
  data: SessionEventData;
}

export interface SessionSnapshot {
  version: 1;
  id: string;
  createdAt: string;
  events: SessionEvent[];
}

export interface SessionDiagnostics {
  id: string;
  seq: number;
  historyMessages: number;
  eventCounts: Record<string, number>;
  openTurns: number[];
  openSteps: Array<{ turn: number; step: number }>;
  pendingInputIds: string[];
  pendingToolCallIds: string[];
  unstartedToolCalls: Array<{ assistantSeq: number; index: number; toolName: string; args: Record<string, any> }>;
  delegations: DelegationState[];
  effects: EffectState[];
}

function cloneJson<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

function assertEvent(event: SessionEvent, expectedSeq: number): void {
  if (!event || event.seq !== expectedSeq || !event.id || !event.type || !event.createdAt) {
    throw new Error(`Invalid session event at sequence ${expectedSeq}.`);
  }

  if (![
    'user/message',
    'assistant/message',
    'tool/result',
    'turn/start',
    'turn/end',
    'step/start',
    'step/end',
    'tool/call',
    'plan/change',
    'goal/change',
    'memory/change',
    'input/queued',
    'input/claimed',
    'agent/delegation',
    'effect/change',
    'skill/change',
    'session/fork',
    'session/compaction',
  ].includes(event.type)) {
    throw new Error(`Unsupported session event type: ${String(event.type)}.`);
  }
}

/**
 * Event-sourced session.
 *
 * The event list is the durable source of truth. `getHistory()` is a
 * compatibility projection for the existing Gemini/OpenAI adapters and is
 * rebuilt from events, including compaction replacement events.
 */
export class Session {
  readonly id: string;
  readonly createdAt: string;
  private readonly eventLog: SessionEvent[];

  constructor(
    id: string = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    events: SessionEvent[] = [],
    createdAt?: string,
  ) {
    if (!id.trim()) {
      throw new Error('Session id must not be empty.');
    }

    this.id = id;
    this.eventLog = events.map((event) => cloneJson(event));
    for (let i = 0; i < this.eventLog.length; i++) {
      assertEvent(this.eventLog[i], i + 1);
    }
    this.createdAt = createdAt || this.eventLog[0]?.createdAt || new Date().toISOString();
  }

  static fromSnapshot(snapshot: SessionSnapshot): Session {
    if (snapshot.version !== 1 || !snapshot.id || !Array.isArray(snapshot.events)) {
      throw new Error('Unsupported or malformed session snapshot.');
    }
    return new Session(snapshot.id, snapshot.events, snapshot.createdAt);
  }

  append(type: SessionEventType, data: SessionEventData): SessionEvent {
    const event: SessionEvent = {
      seq: this.eventLog.length + 1,
      id: `${this.id}:${this.eventLog.length + 1}`,
      type,
      createdAt: new Date().toISOString(),
      data: cloneJson(data),
    };

    assertEvent(event, event.seq);
    this.eventLog.push(event);
    return cloneJson(event);
  }

  get seq(): number {
    return this.eventLog.length;
  }

  get lastEvent(): SessionEvent | undefined {
    const event = this.eventLog[this.eventLog.length - 1];
    return event ? cloneJson(event) : undefined;
  }

  getEvents(): SessionEvent[] {
    return this.eventLog.map((event) => cloneJson(event));
  }

  addUserMessage(text: string, source: 'human' | 'system' | 'injected' = 'human', inputId?: string): void {
    this.append('user/message', {
      source,
      inputId,
      content: {
        role: 'user',
        parts: [{ text }],
      },
    });
  }

  getPendingInputs(): Array<{ inputId: string; text: string; source: 'human' | 'system' | 'injected'; queuedAt: string }> {
    const pending = new Map<string, { inputId: string; text: string; source: 'human' | 'system' | 'injected'; queuedAt: string }>();
    for (const event of this.eventLog) {
      if (event.type === 'input/queued' && event.data.inputId && event.data.inputText) {
        pending.set(event.data.inputId, {
          inputId: event.data.inputId,
          text: event.data.inputText,
          source: event.data.source || 'human',
          queuedAt: event.createdAt,
        });
      } else if (event.type === 'input/claimed' && event.data.inputId) {
        pending.delete(event.data.inputId);
      } else if (event.type === 'user/message' && event.data.inputId) {
        pending.delete(event.data.inputId);
      }
    }
    return Array.from(pending.values());
  }

  addModelMessage(params: { text?: string; functionCalls?: FunctionCall[]; rawContent?: Content }): void {
    if (params.rawContent) {
      const content = cloneJson(params.rawContent);
      const functionCalls = params.functionCalls || [];
      if (functionCalls.length > 0) {
        let callIndex = 0;
        const parts = (content.parts || []).map((part: any) => {
          if (!part.functionCall) return part;
          const call = functionCalls[callIndex++];
          return call
            ? {
                ...part,
                functionCall: {
                  ...part.functionCall,
                  name: call.name || part.functionCall.name,
                  args: call.args || part.functionCall.args || {},
                  id: (call as any).id || part.functionCall.id,
                },
              }
            : part;
        });

        if (callIndex < functionCalls.length) {
          throw new Error('Raw model content is missing functionCall parts; refusing to persist unsigned synthetic calls.');
        }
        content.parts = parts;
      }
      content.role = 'model';
      this.append('assistant/message', { content });
      return;
    }

    const parts: any[] = [];
    if (params.text) {
      parts.push({ text: params.text });
    }

    for (const call of params.functionCalls || []) {
      parts.push({
        functionCall: {
          name: call.name,
          args: call.args || {},
          id: (call as any).id,
        },
      });
    }

    this.append('assistant/message', {
      content: { role: 'model', parts },
    });
  }

  addToolResult(toolName: string, result: Record<string, any>): void {
    this.addToolResultWithId(toolName, result);
  }

  addToolResultWithId(toolName: string, result: Record<string, any>, toolCallId?: string, reason?: string): void {
    this.append('tool/result', {
      toolName,
      toolCallId,
      result,
      reason,
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: toolName,
              id: toolCallId,
              response: result,
            },
          },
        ],
      },
    });
  }

  addMemoryRecord(memory: MemoryRecord, reason = 'memory-saved'): void {
    this.append('memory/change', { memory: cloneJson(memory), reason });
  }

  getMemoryRecords(): MemoryRecord[] {
    const records = new Map<string, MemoryRecord>();
    for (const event of this.eventLog) {
      if (event.type !== 'memory/change' || event.data.memory === undefined) continue;
      if (event.data.memory === null) continue;
      records.set(event.data.memory.id, cloneJson(event.data.memory));
    }
    return Array.from(records.values());
  }

  getDelegationStates(): DelegationState[] {
    const states = new Map<string, DelegationState>();
    for (const event of this.eventLog) {
      if (event.type !== 'agent/delegation' || event.data.delegation === undefined) continue;
      const delegation = event.data.delegation;
      if (delegation === null) {
        states.clear();
        continue;
      }
      states.set(delegation.id, cloneJson(delegation));
    }
    return Array.from(states.values());
  }

  getEffectStates(): EffectState[] {
    const states = new Map<string, EffectState>();
    for (const event of this.eventLog) {
      if (event.type !== 'effect/change' || event.data.effect === undefined) continue;
      const effect = event.data.effect;
      if (effect === null) {
        states.clear();
        continue;
      }
      states.set(effect.id, cloneJson(effect));
    }
    return Array.from(states.values());
  }

  getOpenEffects(): EffectState[] {
    return this.getEffectStates().filter((effect) => effect.status === 'prepared');
  }

  recordSkillDecision(decision: SkillActivationDecision, reason?: string): SessionEvent {
    return this.append('skill/change', {
      skill: cloneJson(decision),
      reason: reason || decision.reason,
    });
  }

  getSkillDecisions(): SkillActivationDecision[] {
    const decisions = new Map<string, SkillActivationDecision>();
    for (const event of this.eventLog) {
      if (event.type === 'skill/change' && event.data.skill) {
        decisions.set(event.data.skill.skillId, cloneJson(event.data.skill));
      }
    }
    return Array.from(decisions.values());
  }

  getActiveSkillDecisions(): SkillActivationDecision[] {
    return this.getSkillDecisions().filter((d) => d.decision === 'activated');
  }

  getDiagnostics(): SessionDiagnostics {
    const eventCounts: Record<string, number> = {};
    const openTurns = new Set<number>();
    const openSteps = new Map<string, { turn: number; step: number }>();

    for (const event of this.eventLog) {
      eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;
      if (event.type === 'turn/start' && event.data.turn !== undefined) {
        openTurns.add(event.data.turn);
      } else if (event.type === 'turn/end' && event.data.turn !== undefined) {
        openTurns.delete(event.data.turn);
      } else if (event.type === 'step/start' && event.data.turn !== undefined && event.data.step !== undefined) {
        openSteps.set(`${event.data.turn}:${event.data.step}`, { turn: event.data.turn, step: event.data.step });
      } else if (event.type === 'step/end' && event.data.turn !== undefined && event.data.step !== undefined) {
        openSteps.delete(`${event.data.turn}:${event.data.step}`);
      }
    }

    return {
      id: this.id,
      seq: this.seq,
      historyMessages: this.getHistory().length,
      eventCounts,
      openTurns: Array.from(openTurns),
      openSteps: Array.from(openSteps.values()),
      pendingInputIds: this.getPendingInputs().map((input) => input.inputId),
      pendingToolCallIds: this.getPendingToolCalls()
        .map((event) => event.data.toolCallId)
        .filter((id): id is string => Boolean(id)),
      unstartedToolCalls: this.getUnstartedToolCalls(),
      delegations: this.getDelegationStates(),
      effects: this.getEffectStates(),
    };
  }

  getPendingToolCalls(): SessionEvent[] {
    const calls = new Map<string, SessionEvent>();
    for (const event of this.eventLog) {
      if (event.type === 'tool/call' && event.data.toolCallId) {
        calls.set(event.data.toolCallId, event);
      } else if (event.type === 'tool/result' && event.data.toolCallId) {
        calls.delete(event.data.toolCallId);
      }
    }
    return Array.from(calls.values()).map((event) => cloneJson(event));
  }

  getUnstartedToolCalls(): Array<{ assistantSeq: number; index: number; toolName: string; args: Record<string, any> }> {
    const unstarted: Array<{ assistantSeq: number; index: number; toolName: string; args: Record<string, any> }> = [];

    for (const assistantEvent of this.eventLog.filter((event) => event.type === 'assistant/message')) {
      const expectedCalls = (assistantEvent.data.content?.parts || [])
        .map((part: any) => part.functionCall)
        .filter(Boolean);
      if (expectedCalls.length === 0) continue;

      const recordedCalls = this.eventLog.filter(
        (event) => event.type === 'tool/call' && event.data.assistantSeq === assistantEvent.seq
      );

      for (let index = 0; index < expectedCalls.length; index++) {
        const expected = expectedCalls[index];
        const recorded = recordedCalls[index];
        if (!recorded || recorded.data.toolName !== expected.name) {
          unstarted.push({
            assistantSeq: assistantEvent.seq,
            index,
            toolName: expected.name || 'unknown_tool',
            args: expected.args || {},
          });
        }
      }
    }

    return unstarted;
  }

  /**
   * Repair a session that was persisted between tool call and tool result, or
   * while a turn/step was open. The repair is itself append-only and therefore
   * replayable and auditable.
   */
  recoverInterrupted(): boolean {
    const unstartedCalls = this.getUnstartedToolCalls();
    const pendingCalls = this.getPendingToolCalls();
    const openEffects = this.getOpenEffects();

    for (const call of unstartedCalls) {
      const toolCallId = `recovery-not-started-${call.assistantSeq}-${call.index}`;
      this.append('tool/call', {
        toolName: call.toolName,
        toolCallId,
        assistantSeq: call.assistantSeq,
        args: call.args,
        reason: 'crash-recovery',
      });
      this.addToolResultWithId(
        call.toolName,
        {
          error: 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.',
          errorCode: 'TOOL_NOT_STARTED',
          retryable: true,
        },
        toolCallId,
        'crash-recovery',
      );
    }

    for (const call of pendingCalls) {
      const toolName = call.data.toolName || 'unknown_tool';
      this.addToolResultWithId(
        toolName,
        {
          error: 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown.',
          errorCode: 'TOOL_OUTCOME_UNKNOWN',
          retryable: false,
        },
        call.data.toolCallId,
        'crash-recovery',
      );
    }

    for (const effect of openEffects) {
      this.append('effect/change', {
        effect: {
          ...effect,
          status: 'failed',
          outcome: 'unknown',
          completedAt: new Date().toISOString(),
          reason: 'crash-recovery',
        },
        reason: 'crash-recovery',
      });
    }

    let openTurn: number | undefined;
    let openStep: { turn: number; step: number } | undefined;
    for (const event of this.eventLog) {
      if (event.type === 'turn/start' && event.data.turn !== undefined) {
        openTurn = event.data.turn;
      } else if (event.type === 'turn/end' && event.data.turn === openTurn) {
        openTurn = undefined;
      } else if (event.type === 'step/start' && event.data.turn !== undefined && event.data.step !== undefined) {
        openStep = { turn: event.data.turn, step: event.data.step };
      } else if (
        event.type === 'step/end' &&
        openStep &&
        event.data.turn === openStep.turn &&
        event.data.step === openStep.step
      ) {
        openStep = undefined;
      }
    }

    const repaired = unstartedCalls.length > 0 || pendingCalls.length > 0 || openEffects.length > 0 || openStep !== undefined || openTurn !== undefined;
    if (openStep) {
      this.append('step/end', {
        turn: openStep.turn,
        step: openStep.step,
        reason: 'crash-recovery',
      });
    }
    if (openTurn !== undefined) {
      this.append('turn/end', {
        turn: openTurn,
        reason: 'interrupted',
      });
    }

    return repaired;
  }

  /**
   * Replace the model-facing projection without deleting the raw history.
   * This is the first compaction seam; later phases can add typed policies.
   */
  setHistory(newHistory: Content[], reason = 'context-compaction'): void {
    this.append('session/compaction', {
      messages: newHistory,
      reason,
    });
  }

  /** Replace a user-facing projected message through the event log. */
  replaceHistory(newHistory: Content[], reason = 'projection-rewrite'): void {
    this.setHistory(newHistory, reason);
  }

  getHistory(): Content[] {
    let projected: Content[] = [];
    const toolCallsByAssistantSeq = new Map<number, SessionEvent[]>();

    for (const event of this.eventLog) {
      if (event.type !== 'tool/call' || event.data.assistantSeq === undefined) continue;
      const calls = toolCallsByAssistantSeq.get(event.data.assistantSeq) || [];
      calls.push(event);
      toolCallsByAssistantSeq.set(event.data.assistantSeq, calls);
    }

    for (const event of this.eventLog) {
      if (event.type === 'session/compaction') {
        projected = cloneJson(event.data.messages || []);
        continue;
      }

      if ((event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result') && event.data.content) {
        const content = cloneJson(event.data.content);

        if (event.type === 'assistant/message') {
          const parts = content.parts || [];
          const existingCallIds = new Set(parts
            .map((part: any) => part.functionCall?.id)
            .filter(Boolean));

          for (const callEvent of toolCallsByAssistantSeq.get(event.seq) || []) {
            const callId = callEvent.data.toolCallId;
            if (callId && existingCallIds.has(callId)) continue;
            parts.push({
              ...(callEvent.data.thoughtSignature
                ? { thoughtSignature: callEvent.data.thoughtSignature }
                : {}),
              functionCall: {
                name: callEvent.data.toolName || 'unknown_tool',
                args: callEvent.data.args || {},
                id: callId,
              },
            });
            if (callId) existingCallIds.add(callId);
          }
          content.parts = parts;
        }

        projected.push(content);
      }
    }

    return projected;
  }

  get messages(): Content[] {
    return this.getHistory();
  }

  toSnapshot(): SessionSnapshot {
    return {
      version: 1,
      id: this.id,
      createdAt: this.createdAt,
      events: this.getEvents(),
    };
  }

  /** Create a replayable child branch without mutating the source session. */
  fork(boundarySeq = this.seq, childId?: string): Session {
    if (!Number.isInteger(boundarySeq) || boundarySeq < 0 || boundarySeq > this.seq) {
      throw new Error(`Fork boundary must be an integer between 0 and ${this.seq}.`);
    }

    const child = new Session(
      childId || `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      this.eventLog.slice(0, boundarySeq),
      this.createdAt,
    );
    child.append('session/fork', {
      parentSessionId: this.id,
      boundarySeq,
      reason: 'fork-created',
    });
    return child;
  }
}
