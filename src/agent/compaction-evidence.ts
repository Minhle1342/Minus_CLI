import type { SessionMessage } from '../session/session.js';
import type { FileDeltaRecord } from '../context/turn-memory-retriever.js';
import type { PlanTaskGraph } from './plan-manager.js';
import { hasObservedMutation, observedMutationFiles, toolResultFailed } from './completion-observations.js';
import { isVerificationCommand } from './completion-evidence.js';
import { CONCURRENT_READ_ONLY_TOOLS } from './tool-execution-scheduler.js';

const brief = (value: unknown, limit = 240): string => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);

/** Only paired, observed outcomes may describe completed file operations. */
export function collectCompactionEvidence(messages: SessionMessage[]): {
  filesTouched: string[];
  fileDeltas: FileDeltaRecord[];
  traces: string[];
} {
  const keyed = new Map<string, any>();
  const unkeyed: any[] = [];
  const filesTouched = new Set<string>();
  const fileDeltas: FileDeltaRecord[] = [];
  const traces: string[] = [];
  for (const message of messages) {
    for (const part of message.parts || []) {
      if (part.functionCall) {
        const call = part.functionCall;
        if (call.id) keyed.set(call.id, call);
        else unkeyed.push(call);
      }
      const response = part.functionResponse;
      if (!response) continue;
      let call: any;
      if (response.id) {
        call = keyed.get(response.id);
        keyed.delete(response.id);
      } else {
        const index = unkeyed.findIndex((item) => item.name === response.name);
        if (index >= 0) call = unkeyed.splice(index, 1)[0];
      }
      if (!call || call.name !== response.name) continue;
      const args = call.args || {};
      const result = response.response as Record<string, any> | undefined;
      if (!result || typeof result !== 'object') continue;
      // A compacted placeholder is not proof that an attempted edit succeeded.
      if (result.status === 'masked' || result.status === 'superseded') continue;
      const failed = toolResultFailed(result);
      if (failed) traces.push(`[FAILED ${call.name}]: ${brief(result.error || result.message || `Exit code ${result.exitCode}`)}`);
      if (hasObservedMutation(call.name, result)) {
        for (const file of observedMutationFiles(call.name, args, result)) {
          filesTouched.add(file);
          const action = call.name.includes('delete') || (Array.isArray(result.filesDeleted) && result.filesDeleted.includes(file)) ? 'deleted'
            : call.name.includes('create') || result.created === true || (Array.isArray(result.filesCreated) && result.filesCreated.includes(file)) ? 'created' : 'modified';
          fileDeltas.push({ path: file, action, modifiedSymbols: args.symbol ? [String(args.symbol)] : undefined,
            summary: `Confirmed via ${call.name}` });
        }
      } else if (!failed && CONCURRENT_READ_ONLY_TOOLS.has(call.name)) {
        const file = args.path || args.filePath || args.targetFile;
        if (typeof file === 'string' && file) {
          filesTouched.add(file);
          fileDeltas.push({ path: file, action: 'read', summary: `Inspected via ${call.name}` });
        }
      }
      if (call.name === 'run_command' && isVerificationCommand(args.command)) {
        const outcome = failed ? 'FAIL' : result.exitCode === 0 ? 'PASS' : 'UNKNOWN';
        const output = [result.stdout, result.stderr].filter((value) => typeof value === 'string').join('\n');
        const counts = output.split(/\r?\n/).filter((line) =>
          /^(?:#\s*(?:tests|pass|fail|skipped|cancelled)\s+\d+|\s*(?:Test Files|Tests)\s+.*|.*\d+\s+(?:passing|failing).*)$/.test(line));
        traces.push(`[VERIFICATION ${outcome}]: ${brief(args.command)}; exitCode=${result.exitCode ?? 'unknown'}${counts.length ? `; ${brief(counts.join('; '))}` : ''}`);
      }
    }
  }
  return { filesTouched: [...filesTouched], fileDeltas, traces: [...new Set(traces)].slice(-12) };
}

export function renderCompactionTaskState(plan?: PlanTaskGraph, completionReason?: string): {
  state: string[];
  nextSteps: string[];
} {
  const state = completionReason ? [`- Last closed turn reason: ${brief(completionReason)}`] : [];
  if (!plan?.nodes.length) return {
    state: [...state, '- Plan status: no execution plan available; task completion is not inferred.'],
    nextSteps: ['- No plan-derived next step available; use the latest user request and preserved turns.'],
  };
  const counts = new Map<string, number>();
  for (const task of plan.nodes) counts.set(task.status, (counts.get(task.status) || 0) + 1);
  state.push(`- Plan status: ${[...counts].map(([status, count]) => `${count} ${status}`).join(', ')}`);
  for (const task of plan.nodes.slice(0, 12)) {
    state.push(`- Task #${task.id} [${task.status}]: ${brief(task.title)}${task.notes ? `; ${brief(task.notes)}` : ''}`);
  }
  for (const blocker of plan.blocked.slice(0, 8)) {
    state.push(`- Blocker #${blocker.taskId}: dependencies=${blocker.dependencyIds.join(',') || 'none'}; failed dependencies=${blocker.failedDependencyIds.join(',') || 'none'}${blocker.permissionBlocker ? `; permission=${brief(blocker.permissionBlocker)}` : ''}`);
  }
  const next = plan.nodes.filter((task) => task.status === 'IN_PROGRESS'
    || (task.status === 'PENDING' && plan.readyTaskIds.includes(task.id)));
  const nextSteps = next.slice(0, 8).map((task) =>
    `- ${task.status === 'IN_PROGRESS' ? 'Continue' : 'Start'} task #${task.id}: ${brief(task.title)}; acceptance: ${brief(task.acceptanceCriteria)}`);
  if (!nextSteps.length) nextSteps.push(plan.nodes.every((task) => task.status === 'COMPLETED' || task.status === 'SKIPPED')
    ? '- Plan has no remaining tasks; wait for the next user instruction.'
    : '- Resolve failed tasks or recorded blockers before continuing; no runnable task is available.');
  return { state, nextSteps };
}
