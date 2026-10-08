import type { CompletionObservation } from './completion-observations.js';
import { hasObservedMutation } from './completion-observations.js';
import { isVerificationCommand, extractCommandString } from './completion-evidence.js';
import { FILE_MUTATION_TOOLS } from '../tools/diff-generator.js';
import { normalizeIntentText, detectExplicitGitMutationIntent } from '../tools/git-intent.js';
import { classifyGitCommand, detectExplicitGitCommandNames, parseGitInvocation, isGitCommandAuthorized } from '../tools/git-command-policy.js';
import { parseShellAst } from '../security/shell-ast-parser.js';
import type { GitWorkflowPromptId } from '../llm/prompt-sections.js';

export type GitWorkflowStage = 'Inspect' | 'Branch' | 'Implement' | 'Commit' | 'Sync' | 'PR';
const ORDER: GitWorkflowStage[] = ['Inspect', 'Branch', 'Implement', 'Commit', 'Sync', 'PR'];
const BRANCH = new Set(['branch', 'switch', 'checkout']);
const INTEGRATION = new Set(['merge', 'rebase', 'cherry-pick']);
const UNDO = new Set(['restore', 'revert', 'reset', 'stash']);
const SYNC = new Set(['fetch', 'pull', 'push']);
const PR_READS = new Set(['pr:view', 'pr:list', 'pr:diff', 'pr:checks', 'pr:status']);

export interface GitWorkflowScope {
  operations: string[];
  branchAction?: 'create' | 'switch' | 'rename' | 'delete';
  branchActions?: Array<'create' | 'switch' | 'rename' | 'delete'>;
  implement: boolean;
  commit: boolean;
  pr: 'publish' | 'prepare' | 'review' | undefined;
}

export interface GitWorkflowState {
  scope: GitWorkflowScope;
  stage: GitWorkflowStage | 'Done';
  completed: Array<{ stage: GitWorkflowStage; evidenceSeq: number }>;
  skipped: GitWorkflowStage[];
  pending: string[];
  blocked?: string;
  playbook?: GitWorkflowPromptId;
  pendingBranchAction?: GitWorkflowScope['branchAction'];
}

export interface GitWorkflowInput {
  userRequest: string;
  observations: readonly CompletionObservation[];
  /** Plan/phase readiness is an extra condition, never a replacement for tool evidence. */
  implementationReady: boolean;
  mayEdit: boolean;
  implementationRequested?: boolean;
}

/** Operation-local negation keeps "commit, do not push" scoped to commit. */
export function gitWorkflowScope(request: string, mayEdit: boolean, implementationRequested = false): GitWorkflowScope {
  const text = normalizeIntentText(request);
  const mutation = detectExplicitGitMutationIntent(request);
  const discussion = /\b(?:how|why|whether|explain|tai sao|giai thich|co can|ho tro)\b/.test(text)
    && !/^(?:please|hay|vui long|thuc hien|chay|commit|push|git)\b/.test(text);
  const names = discussion ? [] : detectExplicitGitCommandNames(request);
  const denied = (name: string) => new RegExp(`\\b(?:do not|dont|never|without|khong|dung)\\s+(?:git\\s+)?${name}\\b`).test(text);
  const operations = names.filter((name) => !denied(name));
  const commit = (mutation.commit || names.includes('commit')) && !discussion && !denied('commit');
  // Commit authorization includes selective staging, but staging alone never includes commit.
  if ((commit || mutation.stage) && (!mutation.commit || commit) && !discussion && !denied('add') && !denied('stage') && !operations.includes('add')) operations.push('add');
  if (!commit) {
    const index = operations.indexOf('commit');
    if (index >= 0) operations.splice(index, 1);
  }
  if (!mutation.push && !names.includes('push')) {
    const index = operations.indexOf('push');
    if (index >= 0) operations.splice(index, 1);
  }
  // Listing refs/stashes does not authorize a branch or stash mutation.
  const branchActions = requestedBranchActions(text);
  const branchAction = branchActions[0];
  if (!branchAction) {
    for (const name of BRANCH) {
      const index = operations.indexOf(name);
      if (index >= 0) operations.splice(index, 1);
    }
  }
  if (!branchActions.length) {
    for (const name of BRANCH) {
      const index = operations.indexOf(name);
      if (index >= 0) operations.splice(index, 1);
    }
  }
  if (/\bgit\s+checkout\s+--\s/.test(text)) {
    const index = operations.indexOf('checkout');
    if (index >= 0) operations.splice(index, 1, 'restore');
  }
  if (/\bgit\s+stash\s+(?:list|show)\b/.test(text) && !/\bstash\s+(?:push|pop|apply|drop|clear)\b/.test(text)) {
    const index = operations.indexOf('stash');
    if (index >= 0) operations.splice(index, 1);
  }
  const prMentioned = /\b(?:pr|pull request)\b/.test(text);
  const pr = !prMentioned || discussion ? undefined
    : /\b(?:do not|dont|never|khong|dung)\s+(?:create|open|update|tao|mo|cap nhat)\s+(?:a\s+)?(?:pr|pull request)\b/.test(text) ? 'review'
    : /\b(?:create|open|update|tao|mo|cap nhat)\s+(?:a\s+)?(?:draft\s+)?(?:pr|pull request)\b/.test(text) ? 'publish'
    : /\b(?:review|danh gia|kiem tra)\b/.test(text) ? 'review' : 'prepare';
  const implement = mayEdit && !discussion
    && (implementationRequested || /\b(?:fix|implement|refactor|build|sua|trien khai|them tinh nang|cap nhat code)\b/.test(text))
    && !/\b(?:do not|dont|without|khong|dung)\s+(?:edit|modify|fix|implement|sua)\b/.test(text);
  return { operations: [...new Set(operations)], branchAction, branchActions, implement, commit, pr };
}

function requestedBranchActions(text: string): NonNullable<GitWorkflowScope['branchActions']> {
  const matches: Array<{ index: number; end: number; action: NonNullable<GitWorkflowScope['branchAction']> }> = [];
  const patterns: Array<[NonNullable<GitWorkflowScope['branchAction']>, RegExp]> = [
    ['delete', /\bgit\s+branch\s+-(?:d|D)\b|\b(?:delete|xoa)\s+(?:the\s+)?(?:branch|nhanh)\b/g],
    ['rename', /\bgit\s+branch\s+-(?:m|M)\b|\b(?:rename|doi ten)\s+(?:the\s+)?(?:branch|nhanh)\b/g],
    ['create', /\bgit\s+(?:checkout\s+-b|switch\s+-c)\b|\bgit\s+branch\s+(?!list\b|show\b)[a-z0-9_][a-z0-9._/-]*\b|\b(?:create|make|tao)\s+(?:a\s+)?(?:new\s+)?(?:branch|nhanh)\b/g],
    ['switch', /\bgit\s+(?:checkout|switch)\b(?!\s+(?:--|-b|-c))|\b(?:switch|chuyen sang)\s+(?:to\s+)?(?:the\s+)?(?:branch|nhanh)\b/g],
  ];
  for (const [action, pattern] of patterns) for (const match of text.matchAll(pattern)) {
    if (/\b(?:do not|dont|never|without|khong|dung)\s*$/.test(text.slice(0, match.index))) continue;
    matches.push({ index: match.index!, end: match.index! + match[0].length, action });
  }
  matches.sort((a, b) => a.index - b.index || b.end - a.end);
  return matches.filter((match, i) => !matches.slice(0, i).some((prior) => prior.index <= match.index && prior.end > match.index)).map((match) => match.action);
}

interface Operation { name: string; args: string[]; }

/** Parse executable commands, never command-looking text printed by echo or an LLM. */
function commandOperations(command: string, evidence = true): Operation[] {
  const parsed = parseShellAst(command);
  // A shell's final exit code cannot prove earlier commands succeeded with ;, || or pipes.
  if (evidence && (parsed.error || parsed.hasSubshell || parsed.hasObfuscation || parsed.operators.some((op) => op !== '&&'))) return [];
  return parsed.commands.flatMap((cmd) => {
    const git = parseGitInvocation(cmd.raw);
    if (git) return [{ name: git.subcommand === 'checkout' && git.args.includes('--') ? 'restore' : git.subcommand, args: git.args }];
    if (/^(?:.*[/\\])?gh(?:\.exe)?$/i.test(cmd.executable) && cmd.args[0] === 'pr') {
      return [{ name: `pr:${cmd.args[1]}`, args: cmd.args.slice(2) }];
    }
    return [];
  });
}

function callOperations(toolName: string, args: Record<string, any>, evidence = true): Operation[] {
  if (toolName === 'run_command') return commandOperations(extractCommandString(args), evidence);
  if (toolName === 'git_command') {
    const argv = Array.isArray(args.args) ? args.args.map(String) : [];
    const name = String(args.subcommand ?? '').toLowerCase();
    return [{ name: name === 'checkout' && argv.includes('--') ? 'restore' : name, args: argv }];
  }
  if (/(?:^|__)(?:create|update)_pull_request$/.test(toolName)) return [{ name: toolName.endsWith('create_pull_request') ? 'pr:create' : 'pr:edit', args: [] }];
  const legacy: Record<string, string> = { git_status: 'status', git_diff: 'diff', git_add: 'add', git_commit: 'commit', git_push: 'push' };
  if (legacy[toolName]) return [{ name: legacy[toolName], args: toolName === 'git_diff' && args.staged ? ['--cached'] : [] }];
  return [];
}

function operationStage(op: Operation, scope?: GitWorkflowScope): GitWorkflowStage | undefined {
  if (PR_READS.has(op.name)) return 'Inspect';
  if (op.name.startsWith('pr:')) return 'PR';
  if (op.name === 'fetch' && scope && (scope.implement || scope.operations.some((name) => BRANCH.has(name) || INTEGRATION.has(name)))) return 'Inspect';
  if (classifyGitCommand(op.name, op.args).risk === 'read') return 'Inspect';
  if (BRANCH.has(op.name) && !(op.name === 'checkout' && op.args.includes('--'))) return 'Branch';
  if (INTEGRATION.has(op.name) || UNDO.has(op.name) || op.name === 'checkout') return 'Implement';
  if (op.name === 'add' || op.name === 'commit') return 'Commit';
  if (SYNC.has(op.name)) return 'Sync';
  return undefined;
}

function branchOperationAction(op: Operation): GitWorkflowScope['branchAction'] {
  if (op.name === 'branch') return op.args.some((arg) => ['-d', '-D', '--delete'].includes(arg)) ? 'delete'
    : op.args.some((arg) => ['-m', '-M', '--move'].includes(arg)) ? 'rename' : 'create';
  return op.args.some((arg) => ['-b', '-B', '-c', '-C', '--create', '--force-create'].includes(arg)) ? 'create' : 'switch';
}

function successful(payload: Record<string, any>, command: boolean): boolean {
  if (payload.error || payload.errorCode || payload.success === false || payload.processStarted === false
    || payload.timedOut || payload.commandOutcome === 'blocked_preflight') return false;
  if (command) return payload.exitCode === 0 && (!payload.commandOutcome || payload.commandOutcome === 'succeeded');
  return payload.success === true;
}

/** Replay paired, durable outcomes for this user request. No mutable cross-session state. */
export function resolveGitWorkflow(input: GitWorkflowInput): GitWorkflowState | undefined {
  const scope = gitWorkflowScope(input.userRequest, input.mayEdit, input.implementationRequested);
  const branchOps = scope.operations.filter((name) => BRANCH.has(name));
  const implementOps = scope.operations.filter((name) => INTEGRATION.has(name) || UNDO.has(name));
  const prerequisiteFetch = scope.operations.includes('fetch') && (scope.implement || branchOps.length > 0 || implementOps.some((name) => INTEGRATION.has(name)));
  const syncOps = scope.operations.filter((name) => SYNC.has(name) && !(name === 'fetch' && prerequisiteFetch));
  const required: GitWorkflowStage[] = ['Inspect'];
  if (branchOps.length) required.push('Branch');
  if (scope.implement || implementOps.length) required.push('Implement');
  if (scope.operations.includes('add') || scope.commit) required.push('Commit');
  if (syncOps.length) required.push('Sync');
  if (scope.pr) required.push('PR');
  // Ordinary code tasks retain baseline Git guidance without becoming release workflows.
  if (required.length === 1 || (!branchOps.length && !implementOps.length && !scope.operations.includes('add') && !scope.commit && !syncOps.length && !scope.pr)) return undefined;
  const state: GitWorkflowState = { scope, stage: 'Inspect', completed: [], skipped: ORDER.filter((s) => !required.includes(s)), pending: [] };
  const inspected = new Set<string>();
  let completedBranchActions = 0;
  const branchActions = scope.branchActions ?? (scope.branchAction ? [scope.branchAction] : []);
  const finishedOperations = new Set<string>();
  const pendingTasks = new Map<string, string>();
  let latestEdit = -1;
  let verifiedEdit = -1;
  const advance = (seq: number) => {
    if (state.stage === 'Done') return;
    state.completed.push({ stage: state.stage, evidenceSeq: seq });
    state.stage = required[state.completed.length] ?? 'Done';
    state.blocked = undefined;
  };
  for (const observation of input.observations) {
    let { toolName, args, payload } = observation;
    const seq = observation.result.seq;
    if (toolName === 'run_command' && payload.isBackgroundTask && payload.taskId) {
      pendingTasks.set(String(payload.taskId), extractCommandString(args));
      continue;
    }
    if (toolName === 'manage_task') {
      const completion = payload.commandCompletion;
      const original = pendingTasks.get(String(completion?.taskId));
      if (!original || completion.completed !== true || completion.command !== original) continue;
      if (completion.terminalStatus !== 'completed') continue;
      pendingTasks.delete(String(completion.taskId));
      toolName = 'run_command';
      args = { command: original };
      payload = { ...payload, ...completion };
    }
    const command = toolName === 'run_command' || toolName === 'git_command';
    const structuredInspection = (toolName === 'git_status' && Array.isArray(payload.status))
      || (toolName === 'git_diff' && typeof payload.diff === 'string');
    const ok = successful(payload, command) || (structuredInspection && !payload.error && !payload.errorCode);
    const edited = hasObservedMutation(toolName, payload) && payload.processStarted !== false && payload.commandOutcome !== 'blocked_preflight';
    // Later edits invalidate earlier verification/commit/sync evidence, including a batch's later calls.
    if (scope.implement && edited) {
      latestEdit = seq;
      verifiedEdit = -1;
    }
    if (scope.implement && edited && (state.stage === 'Done' || ORDER.indexOf(state.stage) >= ORDER.indexOf('Implement'))) {
      state.completed = state.completed.filter((item) => ORDER.indexOf(item.stage) < ORDER.indexOf('Implement'));
      state.stage = 'Implement';
      state.blocked = undefined;
      for (const name of syncOps) finishedOperations.delete(name);
      latestEdit = seq;
      verifiedEdit = -1;
    }
    const operations = callOperations(toolName, args);
    for (const op of operations) {
      const stage = operationStage(op, scope);
      if (stage !== state.stage || op.args.includes('--dry-run') || op.args.includes('--help') || (op.name === 'push' && op.args.includes('-n'))) continue;
      const diffDetected = stage === 'Inspect' && op.name === 'diff' && payload.exitCode === 1
        && payload.commandOutcome === 'difference_detected' && payload.processStarted !== false;
      if (!ok && !diffDetected) {
        state.blocked = `Tool result ${seq} did not complete ${state.stage}; inspect the failure and retry only within the authorized scope.`;
        continue;
      }
      if (stage === 'Inspect') {
        if (op.name === 'fetch' && prerequisiteFetch) inspected.add('fetch');
        if (op.name === 'status') inspected.add('status');
        const baselineDiff = op.name === 'diff' && op.args.every((arg) => arg.startsWith('-'))
          && !op.args.some((arg) => ['--quiet', '--check', '--no-index', '--'].includes(arg));
        if (baselineDiff) inspected.add(op.args.includes('--cached') || op.args.includes('--staged') ? 'staged diff' : 'unstaged diff');
        if (['status', 'unstaged diff', 'staged diff', ...(prerequisiteFetch ? ['fetch'] : [])].every((name) => inspected.has(name))) advance(seq);
      } else if (stage === 'Branch') {
        if (scope.operations.some((name) => BRANCH.has(name)) && branchOperationAction(op) === branchActions[completedBranchActions]) {
          completedBranchActions++;
          if (completedBranchActions === branchActions.length) advance(seq);
        }
      } else if (stage === 'Implement') {
        if (implementOps.includes(op.name)) finishedOperations.add(op.name);
      } else if (stage === 'Commit') {
        if (op.name === 'commit' && scope.commit) advance(seq);
        else if (op.name === 'add' && scope.operations.includes('add') && !scope.commit) advance(seq);
      } else if (stage === 'Sync') {
        if (syncOps.includes(op.name)) finishedOperations.add(op.name);
        if (syncOps.every((name) => finishedOperations.has(name))) advance(seq);
      } else if (stage === 'PR' && scope.pr === 'publish' && ['pr:create', 'pr:edit'].includes(op.name)) {
        if (op.name === 'pr:edit' || /https:\/\/[^\s]+\/pull\/\d+/.test(String(payload.stdout ?? payload.url ?? payload.html_url ?? ''))) advance(seq);
      }
    }
    if (state.stage === 'Implement') {
      if (scope.implement && edited) {
        latestEdit = seq;
        verifiedEdit = -1;
      }
      const verificationShell = toolName === 'run_command' ? parseShellAst(extractCommandString(args)) : undefined;
      const provenShell = verificationShell && !verificationShell.error && !verificationShell.hasSubshell
        && !verificationShell.hasObfuscation && verificationShell.operators.every((op) => op === '&&');
      const verified = (toolName === 'run_command' && ok && provenShell && isVerificationCommand(extractCommandString(args)))
        || (toolName === 'run_test_suite' && payload.exitCode === 0 && payload.isPassed === true && payload.success !== false && !args.useScratchWorkspace && !payload.error && !payload.errorCode)
        || (toolName === 'get_diagnostics' && !args.path && payload.clean === true && payload.success !== false && !payload.error && !payload.errorCode && !payload.totalErrors);
      if (verified && latestEdit >= 0 && seq > latestEdit) verifiedEdit = seq;
      if ((!scope.implement || (verifiedEdit > latestEdit && input.implementationReady))
        && implementOps.every((name) => finishedOperations.has(name))) advance(seq);
    }
    if (state.stage === 'PR' && scope.pr !== 'publish' && ok
      && ['report_findings', 'report_investigation_findings', 'submit_solution'].includes(toolName)) advance(seq);
  }
  if (state.stage === 'Inspect') state.pending = ['status', 'unstaged diff', 'staged diff', ...(prerequisiteFetch ? ['fetch'] : [])].filter((name) => !inspected.has(name));
  if (state.stage === 'Branch') {
    state.pendingBranchAction = branchActions[completedBranchActions];
    state.pending = branchActions.slice(completedBranchActions).map((action) => `branch ${action}`);
  }
  if (state.stage === 'Implement') state.pending = [
    ...implementOps.filter((name) => !finishedOperations.has(name)),
    ...(scope.implement && latestEdit < 0 ? ['successful implementation tool result'] : []),
    ...(scope.implement && verifiedEdit <= latestEdit ? ['successful verification after the latest edit'] : []),
    ...(scope.implement && !input.implementationReady ? ['implementation plan/phase readiness'] : []),
  ];
  if (state.stage === 'Sync') state.pending = syncOps.filter((name) => !finishedOperations.has(name));
  state.playbook = state.stage === 'Inspect' ? 'gitInspect' : state.stage === 'Branch' ? 'gitBranch'
    : state.stage === 'Commit' ? 'gitCommit' : state.stage === 'Sync' ? 'gitSync' : state.stage === 'PR' ? 'gitPrEnhance'
    : state.stage === 'Implement' ? (implementOps.some((op) => UNDO.has(op)) ? 'gitRollback' : implementOps.length ? 'gitIntegrate' : 'gitImplement') : undefined;
  return state;
}

export function gitWorkflowGuidance(state: GitWorkflowState): string {
  return `[GIT WORKFLOW STATE]\nCurrent stage: ${state.stage}. Completed: ${state.completed.map((item) => item.stage).join(' -> ') || 'none'}. Skipped (not requested): ${state.skipped.join(', ') || 'none'}.\nAuthorized operations: ${state.scope.operations.join(', ') || 'none'}; code implementation: ${state.scope.implement}; PR: ${state.scope.pr ?? 'none'}.\n${state.pending.length ? `Required evidence: ${state.pending.join(', ')}.\n` : ''}${state.blocked ? `${state.blocked}\n` : ''}Use separate tool calls for stages. Tool attempts, background starts, dry runs, and narrative claims do not complete a stage. Preserve user changes and the requested paths/refs/remotes; this state does not broaden authorization. ${state.stage === 'Done' ? 'Requested Git workflow is complete; do not repeat Git mutations.' : 'Complete only the current authorized stage before the next Git mutation.'}`;
}

/** Additional ordering guard; existing command/path/branch authorization remains authoritative. */
export function checkGitWorkflowCall(state: GitWorkflowState | undefined, userRequest: string, toolName: string, args: Record<string, any>): string | undefined {
  if (!state) return undefined;
  if (state.scope.implement && FILE_MUTATION_TOOLS.has(toolName) && ['Inspect', 'Branch'].includes(state.stage)) {
    return `Complete ${state.stage} before editing the working tree for this Git workflow.`;
  }
  for (const op of callOperations(toolName, args, false)) {
    const stage = operationStage(op, state.scope);
    if (!stage || (stage === 'Inspect' && op.name !== 'fetch')) continue;
    const equivalentBranch = stage === 'Branch' && state.scope.operations.some((name) => BRANCH.has(name));
    const permitted = op.name.startsWith('pr:') ? state.scope.pr === 'publish' && ['pr:create', 'pr:edit'].includes(op.name)
      : state.scope.operations.includes(op.name) || equivalentBranch;
    if (!permitted) return `Git operation ${op.name} is outside the user-authorized workflow scope.`;
    if (stage === 'Branch' && branchOperationAction(op) !== (state.pendingBranchAction ?? state.scope.branchAction)) return `Next authorized branch action is ${state.pendingBranchAction ?? state.scope.branchAction}; this invocation would ${branchOperationAction(op)} a branch.`;
    if (stage !== state.stage) return `Git ${op.name} belongs to ${stage}, but the current workflow stage is ${state.stage}. Required evidence: ${state.pending.join(', ') || 'successful result for the current stage'}.`;
    if (toolName === 'git_command' && !isGitCommandAuthorized(userRequest, op.name, classifyGitCommand(op.name, op.args), op.args)) {
      return `Git ${op.name} is not authorized by the current user request.`;
    }
  }
  return undefined;
}
