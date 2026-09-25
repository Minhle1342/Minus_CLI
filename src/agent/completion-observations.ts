import type { Session, SessionEvent } from '../session/session.js';
import { FILE_MUTATION_TOOLS } from '../tools/diff-generator.js';
import { isNonFailingCommandOutcome } from '../tools/command-outcome.js';

export interface CompletionObservation {
  call: SessionEvent;
  result: SessionEvent;
  toolName: string;
  args: Record<string, any>;
  payload: Record<string, any>;
}

export function toolResultFailed(result: Record<string, any>): boolean {
  if (isNonFailingCommandOutcome(result)) return false;
  return Boolean(result.error || result.errorCode || result.success === false
    || (typeof result.exitCode === 'number' && result.exitCode !== 0));
}

/**
 * Cache theo (session, seq, turn): event log chỉ append nên cùng một seq cho
 * cùng một kết quả. Các caller chỉ filter/map, không mutate mảng trả về.
 */
const observationCache = new WeakMap<Session, Map<string | number, { seq: number; observations: CompletionObservation[] }>>();
const MAX_CACHED_TURNS_PER_SESSION = 4;

/** Pair observations once, with explicit turn boundaries and consumable call IDs. */
export function collectCompletionObservations(session: Session, turn?: number): CompletionObservation[] {
  const cacheKey = turn ?? 'all';
  let perSession = observationCache.get(session);
  const cached = perSession?.get(cacheKey);
  if (cached && cached.seq === session.seq) return cached.observations;

  const calls = new Map<string, SessionEvent>();
  const unkeyed: SessionEvent[] = [];
  const observations: CompletionObservation[] = [];
  let currentTurn: number | undefined;
  for (const event of session.getEvents()) {
    if (event.type === 'turn/start') {
      currentTurn = event.data.turn;
      calls.clear();
      unkeyed.length = 0;
    }
    const eventTurn = event.data.turn ?? currentTurn;
    if (turn !== undefined && eventTurn !== undefined && eventTurn !== turn) continue;
    if (event.type === 'tool/call') {
      // Legacy events without a turn can only belong to an unscoped/first turn.
      if (turn !== undefined && eventTurn === undefined && turn !== 1) continue;
      if (event.data.toolCallId) calls.set(event.data.toolCallId, event);
      else unkeyed.push(event);
    }
    if (event.type !== 'tool/result') continue;
    let call: SessionEvent | undefined;
    if (event.data.toolCallId) {
      call = calls.get(event.data.toolCallId);
      calls.delete(event.data.toolCallId);
    } else {
      const index = unkeyed.findIndex((item) => !event.data.toolName || item.data.toolName === event.data.toolName);
      if (index >= 0) call = unkeyed.splice(index, 1)[0];
    }
    if (!call) continue;
    observations.push({ call, result: event, toolName: call.data.toolName || event.data.toolName || 'unknown_tool',
      args: call.data.args || {}, payload: event.data.result || {} });
  }
  if (!perSession) {
    perSession = new Map();
    observationCache.set(session, perSession);
  }
  if (!perSession.has(cacheKey) && perSession.size >= MAX_CACHED_TURNS_PER_SESSION) {
    const oldest = perSession.keys().next();
    if (!oldest.done) perSession.delete(oldest.value);
  }
  perSession.set(cacheKey, { seq: session.seq, observations });
  return observations;
}

export function observedMutationFiles(toolName: string, args: Record<string, any>, result: Record<string, any>): string[] {
  if (!hasObservedMutation(toolName, result)) return [];
  const files = new Set<string>();
  const add = (value: unknown) => { if (typeof value === 'string' && value.trim()) files.add(value.trim()); };
  for (const key of ['filesModified', 'modifiedFiles', 'filesCreated', 'filesDeleted', 'changedFiles']) {
    if (Array.isArray(result[key])) for (const file of result[key]) add(typeof file === 'string' ? file : file?.path);
  }
  if (Array.isArray(args.targetFiles)) {
    for (const file of args.targetFiles) add(file);
  }
  if (FILE_MUTATION_TOOLS.has(toolName)) {
    for (const key of ['path', 'filePath', 'targetFile', 'TargetFile', 'target_path', 'file_path', 'sourcePath', 'targetPath']) {
      add(result[key]);
      add(args[key]);
    }
  }
  return [...files];
}

export function hasObservedMutation(toolName: string, result: Record<string, any>): boolean {
  // Inspection and reporting tools can describe changed files without changing them.
  if (!FILE_MUTATION_TOOLS.has(toolName) && result.mutationApplied !== true) return false;
  if (toolResultFailed(result) || result.changed === false || result.noChanges === true || result.rolledBack === true) return false;
  if (typeof result.totalModifiedFiles === 'number' && result.totalModifiedFiles === 0) return false;
  const lists = ['filesModified', 'modifiedFiles', 'filesCreated', 'filesDeleted', 'changedFiles']
    .map((key) => result[key]).filter(Array.isArray);
  if (lists.length) return lists.some((files) => files.length > 0);
  return FILE_MUTATION_TOOLS.has(toolName);
}

export interface TurnCompletionState {
  turn?: number;
  hasMutations: boolean;
  filesModified: string[];
  latestMutationSeq: number;
}

/** Reconstructed from outcomes, never from attempted calls or a session-wide dirty flag. */
export function getTurnCompletionState(session: Session, turn?: number): TurnCompletionState {
  const mutations = collectCompletionObservations(session, turn)
    .filter((item) => hasObservedMutation(item.toolName, item.payload));
  return {
    turn,
    hasMutations: mutations.length > 0,
    filesModified: [...new Set(mutations.flatMap((item) => observedMutationFiles(item.toolName, item.args, item.payload)))],
    latestMutationSeq: mutations.at(-1)?.result.seq ?? -1,
  };
}
