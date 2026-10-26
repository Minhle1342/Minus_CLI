# Background command execution with completion notification

Date: 2026-10-26
Status: proposed (awaiting approval)

## Intent

`run_command` blocks the agent turn for up to 120 s (default `timeout_ms`) while a build,
test, or script runs. The agent cannot read files, plan, or start independent work during
that window. The goal: any finite command that outlives a short threshold keeps running in
the background, the agent continues working, and when the command exits the agent receives a
system notification inside the running turn and handles the result immediately.

## Goals

1. Every finite `run_command` invocation auto-promotes to a background task after the soft
   threshold (default 10 s), including builds and tests. Commands the model explicitly
   launches with `WaitMsBeforeAsync` remain "long-lived" and are not waited on; commands
   matching the existing dev-server/watcher patterns are also treated as long-lived.
2. On task exit the owning session receives a system steering message with command, exit
   code, outcome, and log tail. The message is claimed at the next agent step.
3. A turn does not commit its final answer while auto-promoted tasks from that turn are still
   running. The loop waits (abortable) and then continues.
4. A stalled task (no output for 45 s) notifies the agent so the agent can kill it; there is
   no new hard wait ceiling.
5. `manage_task` is restored so the agent can list, inspect, read logs, send stdin, and kill
   tasks. Its schema and usage guidance are exposed only after a background notification has
   been claimed in the current turn.

## Non-goals

- Background execution under Docker isolation. The host process manager cannot preserve the
  isolation boundary; auto-promotion is skipped when the selected target is an isolated
  sandbox (current `BACKGROUND_ISOLATION_UNSUPPORTED` behavior is unchanged for explicit
  background requests).
- Background network Git (`fetch`/`pull`/`clone`). These stay synchronous; the existing
  `BACKGROUND_GIT_NETWORK_UNSUPPORTED` guard remains for explicit requests.
- Reattaching tasks after a process restart.
- Auto-promotion and the turn-end wait gate inside subagent loops. Subagents keep today's
  behavior: synchronous commands plus explicit `WaitMsBeforeAsync`. A task that outlives its
  subagent is a pre-existing limitation, not repaired here.
- Token-level streaming of background output. Notifications are step-boundary events.
- New user-facing configuration.

## Anti-goals

- A dev server or watcher hangs the turn forever because the wait gate waits for it.
- Auto-promotion silently weakens Docker isolation.
- Notification floods: one completion notice per task, and the existing stall notice remains
  rate-limited to one per minute.
- `manage_task` permanently in the tool schema (schema tokens and prompt noise on every turn).

## Constraints found in the code

- `TaskManager` currently knows nothing about sessions or inboxes; `run_command` only gets
  `ToolExecutionContext.sessionId`.
- Subagent loops own a private `AgentInbox` (`agent-loop.ts:528`), while the main loop uses
  `kernel.ctx.inbox`. A hard-wired kernel inbox would drop notifications from subagent tasks,
  so the inbox must travel with the tool context.
- Tool declarations are cached per turn (`agent-loop.ts:1690`). Flipping `manage_task`
  visibility must change the cache key, otherwise the new declaration never reaches the
  model or leaks into later turns.
- Under `toolControlMode === 'enforce'`, calls outside `authorizedToolNames` fail with
  `TOOL_NOT_ALLOWED_THIS_TURN`. `manage_task` must be added to the authorized set, not only
  to the declarations.
- Verification evidence already understands background tasks through `manage_task`:
  `completion-evidence.ts:146` and `agent-loop.ts:4107` read `action === 'status'` and
  `commandCompletion`. A synchronous `run_command` result with `isBackgroundTask: true` is
  explicitly not counted as test evidence (`agent-loop.ts:1765`), so the completion must be
  observed through `manage_task status`.
- `src/test-suite.ts` still imports `./tools/manage-task.js`, a module that no longer exists
  in the tree; restoring the tool also repairs that reference.

## Approaches considered

**A. TaskManager exit/stall hooks enqueue into the loop inbox (chosen).**
`TaskManager` gains task metadata (session, turn, `autoPromoted`), an exit hook, a stall
watchdog, and an inbox reference supplied by the caller. `run_command` passes the inbox from
`ToolExecutionContext`. The loop waits for auto-promoted tasks before finalizing, claims the
notification at the next step, and unlocks `manage_task`.

**B. Event bus + `agent/pre-step` hook.**
`TaskManager` emits `task:exit` on `AgentEventBus`; a hook decides enqueueing and tool
exposure. More decoupled, but the manager has no bus today and the hook still needs the
task→session map. Only pays off when another consumer needs task events; the TUI reads task
state directly.

**C. Completion queue polled by the loop each step.**
No callbacks; the loop drains a queue at each step boundary. Easy to test, but it cannot wake
a waiting loop, so the turn-end gate would busy-poll and notifications arrive late.

Approach A is the smallest change that satisfies all goals and reuses the proven subagent
completion pattern (`notifySubagentCompletion`, `agent-loop.ts:5772`).

## Design

### 1. Auto-promotion threshold

`resolveAutoBackgroundWait` becomes:

- explicit `WaitMsBeforeAsync > 0` → background after that window, `autoPromoted = false`
  (long-lived);
- no explicit wait, command matches the existing dev-server/watcher patterns → background
  after the soft threshold, `autoPromoted = false` (long-lived, never awaited);
- no explicit wait, any other command → background after the soft threshold,
  `autoPromoted = true` (finite, awaited at turn end);
- `context.isSubagent` → no auto-promotion (today's synchronous behavior);
- no task manager → `undefined` (sync path, unchanged).

The dev-server patterns already live in `command-preflight-guard.ts` (`DEV_SERVER_PATTERNS`);
export them through a small predicate instead of duplicating the regexes. A server the
patterns miss is still released by the stall watchdog after 45 s of silence, so the gate
cannot hold the turn indefinitely.

`timeout_ms` no longer gates promotion. It still bounds the synchronous pre-promotion path
and remains the model's tool for finite long jobs with an explicit timeout.

Promotion is skipped (command stays synchronous) when:

- `execution_target === 'auto'` and the sandbox manager reports an isolated provider
  (Docker). Preserves the isolation invariant instead of failing every long build on Docker
  hosts.
- the command is network Git.

These two exclusions are evaluated on the auto-promotion path only; explicit
`WaitMsBeforeAsync` keeps today's block/error behavior.

### 2. Task metadata, exit and stall notifications

`TaskManager.startTask(command, cwd, env, options?)` with
`options: { sessionId?, turn?, autoPromoted?, inbox? }`. `BackgroundTask` stores the same.

- On exit, if `sessionId` and `inbox` are present, enqueue a system steering message
  (`kind: 'background-task-completed'`, `isSteering: true`, fire-and-forget promise)
  containing: command, task id, exit code, outcome (`succeeded` / `failed_unexpected` /
  `cancelled`), duration, last ~20 log lines, and a short `manage_task` usage block. The
  text is sanitized and secret-redacted before enqueueing.
- A per-task watchdog interval (unref'd) checks idle time. At `STALL_IDLE_MS` it enqueues
  one `background-task-stalled` notice (`isSteering: true`), re-notifying at most every 60 s
  (existing constants), and resolves any waiter with reason `stalled`.
- `waitForAutoPromoted(sessionId, turn, signal)` resolves `completed | stalled | aborted`
  when no auto-promoted task for that session/turn is running, or on abort.
- The claim block must branch on `kind`: notification items do not use the
  `[USER QUEUED MESSAGE (MID-TURN STEERING)]` wording, do not render the user-steering
  notice, and resolve immediately instead of waiting for the final answer. User steering
  keeps its current behavior.
- Listeners are registered/unregistered per task; `dispose()` clears timers.

`AgentInboxItem` gains optional `kind?: string`, passed through `enqueue` options, so the loop
does not parse message text.

`ToolExecutionContext` gains optional `inbox` (type-only import). `agent-loop.ts` passes
`this.inbox` when building the tool context at line ~3815, which covers both the main loop and
each subagent loop.

### 3. Turn-end wait gate

Immediately after the final-answer decision allows completion and before rendering/storing
the answer, the loop checks whether it must wait: an auto-promoted task from this turn is
still running, or the inbox already holds an unclaimed background notice for this session.
A pending notice matters because a task can exit while the model is writing its final
answer; without this check the turn would commit an answer that never saw the result.

- If none (no running auto tasks and no unclaimed notice): unchanged path.
- If some: `await taskManager.waitForAutoPromoted(session.id, turn, signal)` when a task is
  running, then `continue` to the next step. No LLM call is made while waiting. The
  completion notice enqueued on exit is claimed at the top of that next step, so the model
  sees the result before answering. When only a notice is pending, skip the wait and
  `continue` immediately.
- If the result is `stalled`: mark that task as stall-released for the rest of this turn,
  continue immediately with the stall notice claimed, and let the model decide whether to
  keep waiting, inspect, or kill. A stall-released task never blocks the gate again this
  turn, so the gate cannot livelock; a later 60 s re-notification still reaches the model.
- If aborted: existing cancellation path.
- The gate does not consume the turn's step budget. When it engages, extend
  `effectiveMaxSteps` by one using the existing step-lease pattern, otherwise a gate on the
  last step would drop the awaited result.
- The gate runs only in the main loop (`isSubagent === false`). Subagents never gate.

`submit_solution` is rejected while an auto-promoted task from this turn is running, with
`errorCode: 'BACKGROUND_TASKS_PENDING'` and instructions not to retry. The tool result keeps
`hasSubmittedSolution` false, so tools (including `manage_task` once unlocked) stay available.
The final-answer gate remains the backstop for a model that skips submission.

Explicit `WaitMsBeforeAsync` tasks and dev-server-pattern tasks are not waited on; they still
notify on exit and stall.

### 4. `manage_task`

New `src/tools/manage-task.ts`, contract compatible with existing evidence code:

- `list`: running and finished tasks for this workspace.
- `status`: `action`, `taskId`, `status`, `exitCode`, `stalled`, `logTail`, and
  `commandCompletion` (`command`, `completed`, `terminalStatus`, `commandOutcome`,
  `exitCode`). Runs the existing verification recording path.
- `logs`: tail N lines (default 50, capped 200).
- `send_input`, `kill`: as previously documented in prompts and `test-suite.ts`.

Registered from `ToolRegistry.attachTaskManager` (which already re-registers `run_command`) and
excluded from default declarations through a `LAZY_TOOL_NAMES` set in `modelVisibleTools`, so
it stays executable but consumes no schema budget before a notification is claimed.

### 5. Lazy exposure after a claimed notification

The loop keeps `backgroundTaskToolsUnlocked` (false at turn start).

- When the steering-claim block at `agent-loop.ts:1430` claims an item whose `kind` starts
  with `background-task`, set the flag.
- While the flag is true: append `manage_task` to the runtime authorized names for that step,
  inject its declaration into `activeToolDeclarations`, and include the flag in the
  declaration-cache key so the change is applied exactly once.
- The usage guidance lives in the notification message itself, not in a static prompt
  section, so it is loaded only when the notification is claimed and costs zero tokens
  otherwise.
- The flag lasts for the rest of the turn; it resets when the next turn starts.

### 6. Prompt and result wording

- `run_command` background result keeps `isBackgroundTask`, `taskId`, `pid`, `status`,
  `recentLogs`, and gains a line noting that completion will arrive automatically (no
  polling).
- `manage_task` is mentioned only in the notification, not in the static tool description
  shown to the model before a notification exists.

## Files touched

| File | Change |
| --- | --- |
| `src/tasks/task-manager.ts` | metadata, inbox notification, stall watchdog, waiters, dispose cleanup |
| `src/tools/run-command.ts` | threshold logic, exemptions, pass session/turn/inbox/autoPromoted |
| `src/tools/manage-task.ts` | new tool implementation |
| `src/tools/registry.ts` | register the tool on `attachTaskManager`, hide from default declarations |
| `src/tools/types.ts` | optional `inbox` on `ToolExecutionContext` |
| `src/agent/agent-inbox.ts` | optional `kind` on items/options |
| `src/agent/agent-loop.ts` | pass inbox, claim flag, authorized/declaration injection, cache key, wait gate, submit rejection |
| `src/tools/command-preflight-guard.ts` | export the dev-server/watcher predicate |
| `src/tools/run-command-background-safety.test.ts` | updated expectations for auto-promotion |
| new tests | threshold, notification, wait gate, stall, lazy exposure, manage_task evidence |

## Testing

- Unit: `resolveAutoBackgroundWait` thresholds and explicit-wait distinction.
- Unit: `run_command` promotes a slow command, skips promotion for isolated auto target and
  network Git, and marks dev-server patterns `autoPromoted: false`.
- Unit: `TaskManager` enqueues one completion notice with `commandCompletion`, resolves the
  waiter, and emits a rate-limited stall notice.
- Unit: a stall release unblocks the gate for that task for the rest of the turn (no
  livelock) while re-notification still arrives.
- Unit: `manage_task status` returns the evidence shape expected by
  `completion-evidence.ts`.
- Loop-level: fake task manager that finishes after N ms → the turn does not finalize, the
  notification is claimed, `manage_task` appears in declarations only after the claim, and
  the final answer follows.
- Loop-level: `submit_solution` is rejected with `BACKGROUND_TASKS_PENDING` while a task
  runs; a gate that engages on the last step extends the step budget.
- Regression: subagent loops do not auto-promote or gate.
- Regression: existing `run-command-background-safety`, git policy, and intent-gating tests.

## What is left to the builder

- Exact log-tail size in the notification (proposal: 20 lines) and whether to include a
  log file path.
- Whether `manage_task list` should filter by session or workspace (proposal: workspace, all
  tasks, as today's TUI shows).
- Exact wording of the `BACKGROUND_TASKS_PENDING` rejection.
- Test file placement and fake-task-manager helpers.
- Whether to emit a TUI notice when the wait gate engages (proposal: one dim line, reuse the
  steering notice renderer).
