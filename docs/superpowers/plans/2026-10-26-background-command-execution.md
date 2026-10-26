# Background Command Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Long `run_command` invocations keep running in the background, notify the agent on completion or stall, block the turn from finalizing while finite tasks run, and unlock `manage_task` only after a notification is claimed.

**Architecture:** `TaskManager` owns task metadata, exit/stall notices, and waiters. `run_command` auto-promotes finite commands after a soft threshold. The agent loop passes its inbox through `ToolExecutionContext`, waits before committing a final answer, rejects `submit_solution` while finite tasks run, and exposes `manage_task` for the rest of the turn after claiming a notice.

**Tech Stack:** TypeScript, Node `node:test`, existing `TaskManager`/`AgentInbox`/`ToolRegistry` infrastructure.

**Spec:** `docs/superpowers/specs/2026-10-26-background-command-execution-design.md`

## Global Constraints

- Default soft threshold: `MINUS_SOFT_TIMEOUT_MS`, 10000 ms, clamped to 1000–10000.
- Subagents never auto-promote and never run the turn-end gate.
- Docker isolation and network Git stay synchronous; explicit `WaitMsBeforeAsync` keeps today's `BACKGROUND_ISOLATION_UNSUPPORTED` / `BACKGROUND_GIT_NETWORK_UNSUPPORTED` behavior.
- Notifications are `source: 'system'`, `isSteering: true`, and carry `kind` starting with `background-task`.
- No new hard wait ceiling; the 45 s stall notice is the release path.
- `manage_task` is executable at all times once attached but absent from default model declarations.

## Review Focus

1. A dev server started without `WaitMsBeforeAsync` must never hold the turn: pattern detection marks it long-lived and the stall watchdog releases the gate.
2. A command that finishes before the threshold must still return synchronously with its normal result and no task id.
3. A task that exits before the final-answer gate must still deliver its notification and result, with no lost claim.
4. An aborted turn while waiting must cancel cleanly: waiter resolves, timers clear, no dangling promise.
5. A subagent that starts an explicit background task must not auto-promote, gate, or crash the parent.

---

### Task 1: TaskManager notices, stall watchdog, waiters

**Files:**
- Modify: `src/tasks/task-manager.ts`
- Test: `src/tasks/task-manager-background-notice.test.ts` (create)

**Interfaces:**
- Consumes: `AgentInbox` (type only).
- Produces:
  - `interface BackgroundTaskOptions { sessionId?: string; turn?: number; autoPromoted?: boolean; inbox?: Pick<AgentInbox, 'enqueue'> }`
  - `startTask(command: string, cwd?: string, env?: Record<string, string>, options?: BackgroundTaskOptions): BackgroundTask`
  - `hasAutoPromotedRunning(sessionId: string, turn?: number): boolean`
  - `waitForAutoPromoted(sessionId: string, turn: number | undefined, signal?: AbortSignal): Promise<'completed' | 'stalled' | 'aborted'>`
  - `export function shouldEmitStallNotice(task: Pick<BackgroundTask, 'status' | 'lastOutputAt' | 'lastStallNoticeAt'>, now: number, stallIdleMs: number, renotifyMs: number): boolean`
  - `BackgroundTask` gains `sessionId?`, `turn?`, `autoPromoted?`, `stallReleased?`.

- [ ] **Step 1: Write the failing tests**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskManager, shouldEmitStallNotice } from './task-manager.js';

test('exit notice carries the completion contract and resolves the waiter', async () => {
  const calls: any[] = [];
  const tm = new TaskManager(process.cwd());
  tm.startTask('node -e "setTimeout(() => process.exit(0), 100)"', process.cwd(), {}, {
    sessionId: 's1', turn: 1, autoPromoted: true,
    inbox: { enqueue: (sessionId, text, source, options) => { calls.push({ sessionId, text, source, options }); return {} as any; } } as any,
  });
  assert.equal(tm.hasAutoPromotedRunning('s1', 1), true);
  assert.equal(await tm.waitForAutoPromoted('s1', 1), 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, 's1');
  assert.equal(calls[0].source, 'system');
  assert.equal(calls[0].options.isSteering, true);
  assert.equal(calls[0].options.kind, 'background-task-completed');
  assert.match(calls[0].text, /task_1/);
});

test('waitForAutoPromoted returns aborted when the signal is already aborted', async () => {
  const tm = new TaskManager(process.cwd());
  const controller = new AbortController();
  controller.abort();
  assert.equal(await tm.waitForAutoPromoted('s1', 1, controller.signal), 'aborted');
});

test('stall notice is emitted once per idle window and re-notified after the cooldown', () => {
  const now = 1_000_000;
  assert.equal(shouldEmitStallNotice({ status: 'running', lastOutputAt: now - 46_000 }, now, 45_000, 60_000), true);
  assert.equal(shouldEmitStallNotice({ status: 'running', lastOutputAt: now - 46_000, lastStallNoticeAt: now - 1_000 }, now, 45_000, 60_000), false);
  assert.equal(shouldEmitStallNotice({ status: 'stopped', lastOutputAt: now - 46_000 }, now, 45_000, 60_000), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test src/tasks/task-manager-background-notice.test.ts`
Expected: FAIL — `shouldEmitStallNotice` is not exported / `startTask` accepts no options.

- [ ] **Step 3: Implement metadata, notices, watchdog, waiter**

Implementation notes:
- Store the four options on the task.
- On `exit`, compute outcome: `succeeded` when `status === 'stopped' && exitCode === 0 && !stopRequested`; `cancelled` when `stopRequested`; else `failed_unexpected`. Enqueue once when `sessionId` and `inbox` exist. Text: `[BACKGROUND TASK COMPLETED] <command> (<taskId>) finished with exit code <n> (<outcome>).` plus the last 20 log lines and one line telling the model to call `manage_task` (`status`, `logs`, `kill`).
- Start a per-task `setInterval(..., 5_000).unref()` watchdog that calls `shouldEmitStallNotice`; on true, set `lastStallNoticeAt`, set `stallReleased = true`, and enqueue a `background-task-stalled` notice. Clear it on exit and in `dispose()`.
- `hasAutoPromotedRunning` ignores `stallReleased` tasks.
- `waitForAutoPromoted` polls every 100 ms: abort → `'aborted'`; any non-released running auto task that now satisfies the stall helper → emit the stall notice and return `'stalled'`; no running auto tasks left → `'completed'`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test src/tasks/task-manager-background-notice.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tasks/task-manager.ts src/tasks/task-manager-background-notice.test.ts
git commit -m "feat(tasks): add completion/stall notices and waiters to TaskManager"
```

---

### Task 2: Auto-promotion threshold, long-lived detection, metadata pass-through

**Files:**
- Modify: `src/tools/command-preflight-guard.ts`
- Modify: `src/tools/run-command.ts`
- Test: `src/tools/run-command-auto-background.test.ts` (create)

**Interfaces:**
- Consumes: `TaskManager` API from Task 1.
- Produces:
  - `export function isLongRunningServerCommand(command: string): boolean` in `command-preflight-guard.ts`
  - `resolveAutoBackgroundWait(waitMsBeforeAsync: number | undefined, timeoutMs: number, taskManager?: TaskManager, options?: { longLived?: boolean; isSubagent?: boolean }): number | undefined`
  - Background result gains `autoPromoted?: boolean` (already present) and `longLived?: boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRunCommandTool, resolveAutoBackgroundWait } from './run-command.js';
import { isLongRunningServerCommand } from './command-preflight-guard.js';
import { Workspace } from '../workspace/workspace.js';

function fakeTaskManager() {
  const started: any[] = [];
  return {
    started,
    startTask: (command: string, cwd: string, env: object, options: any) => {
      const task = { id: `task_${started.length + 1}`, command, cwd, status: 'running', logs: [], pid: 1 };
      started.push({ command, options, task });
      return task;
    },
    hasAutoPromotedRunning: () => false,
    waitForAutoPromoted: async () => 'completed' as const,
    listTasks: () => [],
  } as any;
}

test('a finite command without WaitMsBeforeAsync auto-promotes as awaited', async () => {
  process.env.MINUS_SOFT_TIMEOUT_MS = '50';
  const tm = fakeTaskManager();
  const result = await createRunCommandTool(undefined, tm).execute(
    { command: 'node -e "setInterval(() => {}, 1000)"' }, new Workspace(),
  );
  delete process.env.MINUS_SOFT_TIMEOUT_MS;
  assert.equal(result.isBackgroundTask, true);
  assert.equal(result.autoPromoted, true);
  assert.equal(tm.started[0].options.autoPromoted, true);
});

test('a command that finishes before the threshold stays synchronous', async () => {
  process.env.MINUS_SOFT_TIMEOUT_MS = '5000';
  const tm = fakeTaskManager();
  const result = await createRunCommandTool(undefined, tm).execute(
    { command: 'node -e "console.log(1)"' }, new Workspace(),
  );
  delete process.env.MINUS_SOFT_TIMEOUT_MS;
  assert.equal(result.isBackgroundTask, undefined);
  assert.equal(result.success, true);
  assert.equal(tm.started.length, 0);
});

test('an explicit WaitMsBeforeAsync command is long-lived', async () => {
  const tm = fakeTaskManager();
  await createRunCommandTool(undefined, tm).execute(
    { command: 'node -e "setInterval(() => {}, 1000)"', WaitMsBeforeAsync: 50 }, new Workspace(),
  );
  assert.equal(tm.started[0].options.autoPromoted, false);
});

test('dev-server patterns are promoted but never awaited', async () => {
  process.env.MINUS_SOFT_TIMEOUT_MS = '10';
  const tm = fakeTaskManager();
  const result = await createRunCommandTool(undefined, tm).execute({ command: 'npm run dev' }, new Workspace());
  delete process.env.MINUS_SOFT_TIMEOUT_MS;
  assert.equal(isLongRunningServerCommand('npm run dev'), true);
  assert.equal(result.longLived, true);
  assert.equal(tm.started[0].options.autoPromoted, false);
});

test('auto-promotion does not cross an isolated sandbox boundary', async () => {
  const tm = fakeTaskManager();
  const sandbox = {
    getStatus: () => ({ isIsolated: true, fallbackToLocal: false }),
    exec: async () => ({ stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1, sandboxType: 'docker', success: true }),
  } as any;
  const result = await createRunCommandTool(sandbox, tm).execute({ command: 'npm test' }, new Workspace());
  assert.equal(tm.started.length, 0);
  assert.equal(result.preflightCode, undefined);
});

test('subagent contexts never auto-promote', () => {
  const tm = fakeTaskManager();
  assert.equal(resolveAutoBackgroundWait(undefined, 120000, tm, { isSubagent: true }), undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test src/tools/run-command-auto-background.test.ts`
Expected: FAIL — `isLongRunningServerCommand` missing; `autoPromoted`/`longLived` undefined.

- [ ] **Step 3: Implement the predicate, threshold, and exemptions**

Implementation notes:
- Export `isLongRunningServerCommand` that tests `DEV_SERVER_PATTERNS.some(...)`.
- `resolveAutoBackgroundWait`: explicit wait wins (long-lived); `options.isSubagent && !explicit` → `undefined`; `options.longLived && !explicit` → soft threshold; otherwise soft threshold. Soft value from `MINUS_SOFT_TIMEOUT_MS`, default 10000, clamp 1000–10000; no task manager → `undefined`.
- In `run-command.ts`, compute `explicitWait`, `longLived = isLongRunningServerCommand(effectiveCommand)`, `autoPromoted = effectiveWaitMs !== undefined && !explicitWait && !longLived`. Pass `{ sessionId: context?.sessionId, turn: context?.turn, autoPromoted, inbox: (context as any)?.inbox }` to `startTask` (Task 4 adds the typed `inbox` field).
- Isolation/net Git: when blocked and `autoPromoted`, fall through to the synchronous path; when not `autoPromoted`, return today's error objects unchanged.
- Background result: add `longLived: true` when `longLived`; keep `autoPromoted`. Update the result `message`/`instruction` to say the completion notice arrives automatically and there is no need to poll.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test src/tools/run-command-auto-background.test.ts src/tools/run-command-background-safety.test.ts src/tools/run-command-git-policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/command-preflight-guard.ts src/tools/run-command.ts src/tools/run-command-auto-background.test.ts
git commit -m "feat(run-command): auto-promote finite commands and mark long-lived ones"
```

---

### Task 3: `manage_task` tool

**Files:**
- Create: `src/tools/manage-task.ts`
- Test: `src/tools/manage-task.test.ts` (create)

**Interfaces:**
- Consumes: `TaskManager` (`listTasks`, `getTask`, `getTaskLogs`, `getStallInfo`, `sendInput`, `stopTask`).
- Produces: `export function createManageTaskTool(taskManager: TaskManager): ToolDefinition`.
- Actions: `list`, `status`, `logs`, `send_input`, `kill`; accepts `Action` or `action`, `TaskId` or `taskId`, `Input` or `input`, `Lines` or `lines`.

- [ ] **Step 1: Write the failing tests**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskManager } from '../tasks/task-manager.js';
import { createManageTaskTool } from './manage-task.js';
import { Workspace } from '../workspace/workspace.js';

test('status returns the evidence-compatible completion contract', async () => {
  const tm = new TaskManager(process.cwd());
  const tool = createManageTaskTool(tm);
  const workspace = new Workspace();
  const task = tm.startTask('node -e "process.exit(0)"', process.cwd());
  while (task.status === 'running') await new Promise((r) => setTimeout(r, 20));

  const result = await tool.execute({ Action: 'status', TaskId: task.id }, workspace);
  assert.equal(result.action, 'status');
  assert.equal(result.status, 'stopped');
  assert.equal(result.commandCompletion.completed, true);
  assert.equal(result.commandCompletion.terminalStatus, 'completed');
  assert.equal(result.commandCompletion.commandOutcome, 'succeeded');
  assert.equal(result.commandCompletion.exitCode, 0);
  assert.match(String(result.logTail), /exited with code/);

  const list = await tool.execute({ Action: 'list' }, workspace);
  assert.equal(list.action, 'list');
  assert.equal(list.count, 1);
});

test('send_input and kill work on a running task', async () => {
  const tm = new TaskManager(process.cwd());
  const tool = createManageTaskTool(tm);
  const workspace = new Workspace();
  const task = tm.startTask('node -e "process.stdin.resume(); setInterval(() => {}, 1000)"', process.cwd());
  assert.equal((await tool.execute({ Action: 'send_input', TaskId: task.id, Input: 'PING' }, workspace)).success, true);
  assert.equal((await tool.execute({ Action: 'kill', TaskId: task.id }, workspace)).success, true);
});

test('unknown task id returns a structured error', async () => {
  const tool = createManageTaskTool(new TaskManager(process.cwd()));
  const result = await tool.execute({ Action: 'status', TaskId: 'task_999' }, new Workspace());
  assert.equal(result.errorCode, 'TASK_NOT_FOUND');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test src/tools/manage-task.test.ts`
Expected: FAIL — cannot find module `./manage-task.js`.

- [ ] **Step 3: Implement the tool**

Implementation notes:
- `status` builds `commandCompletion` from the task: `command`, `completed: status !== 'running'`, `terminalStatus` (`stopped` → `completed`, `failed` → `failed`, `stopRequested` → `cancelled`), `commandOutcome` (`succeeded` / `failed_unexpected` / `cancelled`), `exitCode`.
- `logTail` is `getTaskLogs(id, 40)`; include `stalled` from `getStallInfo`.
- `list` returns tasks without logs; `logs` returns the tail; `send_input` and `kill` return `{ action, taskId, success }`.
- Description must stay short and mention only the actions, not background-notification rules.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test src/tools/manage-task.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/manage-task.ts src/tools/manage-task.test.ts
git commit -m "feat(tools): restore manage_task for background task inspection"
```

---

### Task 4: Inbox notice kind and claim handling

**Files:**
- Modify: `src/agent/agent-inbox.ts`
- Modify: `src/agent/agent-loop.ts` (claim block, tool context inbox)
- Modify: `src/tools/types.ts`
- Test: `src/agent/agent-inbox.test.ts`

**Interfaces:**
- Consumes: `AgentInboxItem`.
- Produces:
  - `AgentInboxItem.kind?: string`
  - `enqueue(..., options?: { id?: string; enqueuedAt?: string; isSteering?: boolean; kind?: string })`
  - `export function isBackgroundTaskNotice(item: Pick<AgentInboxItem, 'kind'>): boolean` — true when `kind` starts with `background-task`
  - `hasPendingKind(sessionId: string, kindPrefix: string): boolean` on `AgentInbox`
  - `ToolExecutionContext.inbox?: Pick<AgentInbox, 'enqueue'>`

- [ ] **Step 1: Write the failing tests**

```ts
test('enqueue preserves the background notice kind', () => {
  const inbox = new AgentInbox();
  const item = inbox.enqueue('session', 'done', 'system', { isSteering: true, kind: 'background-task-completed' });
  assert.equal(item.kind, 'background-task-completed');
  assert.equal(isBackgroundTaskNotice(item), true);
  assert.equal(isBackgroundTaskNotice(inbox.enqueue('session', 'hi', 'human')), false);
});

test('hasPendingKind finds unclaimed background notices only', () => {
  const inbox = new AgentInbox();
  inbox.enqueue('session', 'notice', 'system', { isSteering: true, kind: 'background-task-completed' });
  inbox.enqueue('session', 'steer', 'human', { isSteering: true });
  assert.equal(inbox.hasPendingKind('session', 'background-task'), true);
  assert.equal(inbox.hasPendingKind('session', 'user'), false);
  assert.equal(inbox.hasPendingKind('other-session', 'background-task'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/agent/agent-inbox.test.ts`
Expected: FAIL — `isBackgroundTaskNotice` not exported / `kind` not preserved.

- [ ] **Step 3: Implement kind and branch the claim block**

Implementation notes:
- Thread `kind` through `enqueue` and `claim` into the item; add `hasPendingKind` that scans the session queue for an unclaimed item whose `kind` starts with the prefix.
- In the claim block (`agent-loop.ts:1430`): when `isBackgroundTaskNotice(steerItem)`, use the raw text (no `[USER QUEUED MESSAGE (MID-TURN STEERING)]` prefix), skip `CLI.renderSteeringNotice`, set `this.backgroundTaskToolsUnlocked = true`, and `steerItem.resolve('')` instead of pushing it to `claimedSteerItems`.
- Pass `inbox: this.inbox` in the tool execution context at `agent-loop.ts:3815`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test src/agent/agent-inbox.test.ts src/agent/agent-loop-bug-fixes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent-inbox.ts src/agent/agent-loop.ts src/tools/types.ts src/agent/agent-inbox.test.ts
git commit -m "feat(agent): claim background task notices as system steering"
```

---

### Task 5: Register and hide `manage_task`

**Files:**
- Modify: `src/tools/registry.ts`
- Test: `src/tools/registry-model-exposure.test.ts`

**Interfaces:**
- Consumes: `createManageTaskTool` from Task 3.
- Produces: `LAZY_TOOL_NAMES` set; `attachTaskManager` registers `manage_task`.

- [ ] **Step 1: Write the failing test**

```ts
test('manage_task is executable but hidden until unlocked', () => {
  const registry = new ToolRegistry();
  registry.attachTaskManager({
    listTasks: () => [], getTask: () => undefined, getTaskLogs: () => '', getStallInfo: () => undefined,
    sendInput: () => false, stopTask: async () => false,
  } as any);
  assert.equal(registry.get('manage_task') !== undefined, true);
  assert.equal(registry.getFunctionDeclarations().some((t) => t.name === 'manage_task'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/tools/registry-model-exposure.test.ts`
Expected: FAIL — `manage_task` is not registered.

- [ ] **Step 3: Implement registration and lazy hiding**

Implementation notes:
- Add `export const LAZY_TOOL_NAMES = new Set(['manage_task'])` and filter it out inside `modelVisibleTools` alongside `MODEL_HIDDEN_TOOL_NAMES`.
- In `attachTaskManager`, call `this.register(createManageTaskTool(taskManager))` after re-registering `run_command`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/tools/registry-model-exposure.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/registry.ts src/tools/registry-model-exposure.test.ts
git commit -m "feat(tools): register manage_task behind a lazy exposure gate"
```

---

### Task 6: Turn-end gate, `submit_solution` rejection, lazy unlock

**Files:**
- Modify: `src/agent/types.ts`
- Modify: `src/agent/agent-loop.ts`
- Test: `src/agent/agent-loop-background-gate.test.ts` (create)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `AgentLoopOptions.taskManager?: TaskManager`
  - loop fields `backgroundTaskToolsUnlocked`, `cachedBackgroundTaskToolsUnlocked`
  - gate decision `{ mode: 'background-wait' }` in `control/decision`.

- [ ] **Step 1: Write the failing tests**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentLoop } from './agent-loop.js';
import { ToolRegistry } from '../tools/registry.js';
import { Session } from '../session/session.js';
import { Workspace } from '../workspace/workspace.js';

class ScriptedLLM {
  calls: Array<{ tools: string[]; prompt: string }> = [];
  async generate(session: Session, tools: any[] = []): Promise<any> {
    this.calls.push({ tools: tools.map((t) => t.name), prompt: JSON.stringify(session.getHistory()) });
    return { text: this.calls.length === 1 ? 'The project is a CLI coding agent.' : 'Background tests passed.' };
  }
}

test('a pending auto-promoted task delays the final answer and unlocks manage_task', async () => {
  const workspace = new Workspace();
  const llm = new ScriptedLLM();
  let pending = true;
  let loop: AgentLoop;
  const taskManager = {
    hasAutoPromotedRunning: () => pending,
    waitForAutoPromoted: async () => {
      pending = false;
      loop.inbox.enqueue('s-bg', '[BACKGROUND TASK COMPLETED] task_1 npm test exited 0. Use manage_task.', 'system', { isSteering: true, kind: 'background-task-completed' });
      return 'completed' as const;
    },
    listTasks: () => [],
  } as any;
  loop = new AgentLoop(llm as any, new ToolRegistry(), { workspace, taskManager, maxSteps: 1 });
  const session = new Session('s-bg');
  session.addUserMessage('What does this project do?');

  const answer = await loop.run(session);

  assert.equal(answer, 'Background tests passed.');
  assert.equal(llm.calls.length, 2, 'the gate must consume a leased step, not drop the answer');
  assert.equal(llm.calls[0].tools.includes('manage_task'), false);
  assert.equal(llm.calls[1].tools.includes('manage_task'), true);
  assert.match(llm.calls[1].prompt, /BACKGROUND TASK COMPLETED/);
});

test('a notice that arrives before the final answer is still claimed', async () => {
  const workspace = new Workspace();
  const llm = new ScriptedLLM();
  let loop: AgentLoop;
  const taskManager = {
    hasAutoPromotedRunning: () => false,
    waitForAutoPromoted: async () => 'completed' as const,
    listTasks: () => [],
  } as any;
  loop = new AgentLoop(llm as any, new ToolRegistry(), { workspace, taskManager, maxSteps: 1 });
  const session = new Session('s-notice');
  session.addUserMessage('What does this project do?');
  // The task exited while the model was writing its answer; the notice is already queued.
  loop.inbox.enqueue('s-notice', '[BACKGROUND TASK COMPLETED] task_2 npm test exited 0. Use manage_task.', 'system', { isSteering: true, kind: 'background-task-completed' });

  const answer = await loop.run(session);

  assert.equal(answer, 'Background tests passed.');
  assert.equal(llm.calls.length, 2, 'a pending notice must not be skipped by the final answer');
  assert.match(llm.calls[1].prompt, /BACKGROUND TASK COMPLETED/);
});

test('subagent loops never gate on background tasks', async () => {
  const workspace = new Workspace();
  const llm = new ScriptedLLM();
  const waitForAutoPromoted = async () => { throw new Error('subagent must not wait'); };
  let loop = new AgentLoop(llm as any, new ToolRegistry(), {
    workspace, agentId: 'subagent-test', enableSubagents: false, maxSteps: 1,
    taskManager: { hasAutoPromotedRunning: () => true, waitForAutoPromoted, listTasks: () => [] } as any,
  });
  const session = new Session('s-sub');
  session.addUserMessage('Report the file count.');

  const answer = await loop.run(session);

  assert.equal(typeof answer, 'string');
  assert.equal(llm.calls.length, 1, 'subagent finalizes without the gate');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test src/agent/agent-loop-background-gate.test.ts`
Expected: FAIL — the first final answer commits (only one LLM call, no `manage_task` declaration); the queued notice is skipped; the subagent test throws.

- [ ] **Step 3: Implement the gate and lazy unlock**

Implementation notes:
- Add `taskManager` to `AgentLoopOptions`; in the constructor set `this.taskManager = options?.taskManager ?? this.kernel?.ctx.tasks`.
- Reset `backgroundTaskToolsUnlocked` next to `targetFilesModifiedInTurn.clear()` (~line 1165).
- Gate: after the `!finalAnswerDecision.allow` block and before `consecutiveIncompleteFinals = 0` (~line 5072), trigger when `!isSubagent && (this.taskManager?.hasAutoPromotedRunning(session.id, turn) || this.inbox.hasPendingKind(session.id, 'background-task'))`. Extend `effectiveMaxSteps` by `Math.min(1, maxLeasedSteps - effectiveMaxSteps)`, append `control/decision { mode: 'background-wait' }`; when a task is running, `await this.taskManager.waitForAutoPromoted(session.id, turn, options?.signal)`; persist and `continue`. Aborted signals are handled by the next loop iteration's abort check.
- `submit_solution`: add `backgroundPending` to the `submitGateBlocked` expression (~line 3718) and prioritize `BACKGROUND_TASKS_PENDING` in the error-code ternary with a message telling the model not to retry and that the completion notice will arrive.
- Lazy unlock at the step surface: when `backgroundTaskToolsUnlocked`, wrap `recommendedToolDecision.toolSurface` with `createToolSurface([...authorized, 'manage_task'], visible)`; add `manage_task`'s declaration from `candidateProvider.get('manage_task')` after retrieval; add `cachedBackgroundTaskToolsUnlocked === backgroundTaskToolsUnlocked` to the declaration-cache condition and store it on rebuild.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test src/agent/agent-loop-background-gate.test.ts src/agent/agent-loop-bug-fixes.test.ts src/agent/completion-policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/types.ts src/agent/agent-loop.ts src/agent/agent-loop-background-gate.test.ts
git commit -m "feat(agent): wait for background tasks before finalizing a turn"
```

---

### Task 7: Full verification

**Files:** none.

- [ ] **Step 1: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors (pre-existing Playwright errors are allowed).

- [ ] **Step 2: Targeted tests**

Run: `node --import tsx --test src/tasks/task-manager-background-notice.test.ts src/tools/run-command-auto-background.test.ts src/tools/run-command-background-safety.test.ts src/tools/manage-task.test.ts src/tools/registry-model-exposure.test.ts src/agent/agent-inbox.test.ts src/agent/agent-loop-background-gate.test.ts`
Expected: PASS.

- [ ] **Step 3: Legacy suite sanity**

Run: `node --max-old-space-size=4096 --import tsx src/test-suite.ts`
Expected: exits 0; the restored `manage_task` import resolves.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "test: verify background command execution end to end"
```
