# GitNexus Engineering Plan

> Task: Fix agent loop auto-interruption, background stall watchdog spam, and verification clobbering.
> Evidence verified at commit 012b2a0eba2c01ef3b68e8d81db42de6f5282272; GitNexus index fresh (Minus_CLI @ 012b2a0).
> Evidence provenance schema 2; global dirty digest 4523c3eb6c994e4ddf9c95e40f62f3b36c0c00335fbfa2c33e060e71f30774b3; cited-path manifest 9 sorted entries; exact generated plan path excluded.

## Objective (§1)

Fix root causes in `MinusCLI` that prematurely interrupt `src/agent/agent-loop.ts`, spawn phantom turns, and terminate sessions with `incomplete-final-answer-terminal`: (1) prevent background stall watchdog from spamming notices on long-lived servers (`npm run dev`); (2) prevent non-verification commands (`git diff`, inspection tools) from clobbering passed test records in `VerificationPolicy`; (3) prevent empty-target false positives in `ProcessFailureDetector` for `run_command`.

## Current Behaviour (§2–3)

1. `src/tasks/task-manager.ts:150`: Watchdog checks `shouldEmitStallNotice` every 5s; every 60s idle (`now - lastOutputAt >= 45s`), it emits a `background-task-stalled` steering message, unaware whether the task is a daemon/server (`longLived`).
2. `src/agent/agent-loop.ts:5451`: At turn finish, `this.inbox.hasPendingKind(session.id, 'background-task')` triggers `mode: 'background-wait'`, clears submission readiness, erases candidate final answers, and forces the loop to continue into a new step or spawns unprompted turns when idle.
3. `src/agent/agent-loop.ts:4278`: Every `run_command` calls `recordVerification`. In `src/skills/verification-policy.ts:266`, non-verification commands (`git diff`) evaluate `effectiveSuccess = false` and unconditionally overwrite `lastVerification`. `canComplete()` (line 378) rejects subsequent completion with `VERIFICATION_FAILED`, terminating the loop at line 5443 with `incomplete-final-answer-terminal`.
4. `src/agent/process-failure-detector.ts:236`: `run_command` in `INSPECTION_TOOLS` has no `path` argument; `inspectedTarget` defaults to `""`, failing keyword relevance and triggering false `RELEVANCE_DRIFT` warnings.

## Findings (§4–5)

- [verified] `shouldEmitStallNotice` (`src/tasks/task-manager.ts:59`): Only checks `status`, `lastOutputAt`, `lastStallNoticeAt`. Dev servers (`longLived`) are completely unrepresented in `BackgroundTaskOptions`.
- [verified] `recordVerification` (`src/skills/verification-policy.ts:260`): Overwrites `this.lastVerification` unconditionally with `effectiveSuccess = false` for non-verification commands, wiping out prior passing test evidence.
- [verified] `canComplete` (`src/skills/verification-policy.ts:378`): Blocks completion if `!this.lastVerification?.success`, directly converting harmless `git diff` checks into terminal loop aborts.
- [verified] `detectProcessFailure` (`src/agent/process-failure-detector.ts:235`): `inspectedTarget` does not extract `command` or `CommandLine`, causing `consecutiveDriftingSteps` to falsely increment.
- [graph] `shouldEmitStallNotice` has 2 d=1 callers: `watchdog` and `waitForAutoPromoted` in `src/tasks/task-manager.ts`.
- [graph] `recordVerification` is called by `agent-loop.ts:4278` and verified across `src/skills/verification-policy.test.ts`.

## Proposed Changes (§6)

1. `src/tasks/task-manager.ts`:
   - Add `longLived?: boolean` to `BackgroundTaskOptions` and `BackgroundTask`.
   - Update `shouldEmitStallNotice` to return `false` if `task.longLived` is true.
   - For finite tasks, ensure stall notices are one-shot (do not continuously re-enqueue every 60s once `stallReleased` is true).
2. `src/tools/run-command.ts`:
   - Pass `longLived: Boolean(longLived)` into `taskManager.startTask(...)` options at line 1894.
3. `src/skills/verification-policy.ts`:
   - In `recordVerification(...)`: if `!isVerification && !isTrivialDirectRun`, do not overwrite an existing successful `lastVerification`. Preserve prior green test evidence while recording non-verification runs in `verificationHistory`.
4. `src/agent/process-failure-detector.ts`:
   - In `detectProcessFailure(...)`: for `run_command`, extract target from `args.command` or `args.CommandLine` to check keyword relevance.

## Implementation Sequence (§7)

- [x] Task 1: Update `src/tasks/task-manager.ts` and `src/tools/run-command.ts` to support `longLived` and suppress stall notice storms for background servers.
- [x] Task 2: Update `src/skills/verification-policy.ts` to preserve passing `lastVerification` when subsequent non-verification commands execute.
- [x] Task 3: Update `src/agent/process-failure-detector.ts` to parse `command` / `CommandLine` args for `run_command`.
- [x] Task 4: Run targeted test suites (`task-manager-background-notice.test.ts`, `verification-policy.test.ts`, `process-failure-detector.test.ts`, `agent-loop-background-gate.test.ts`).
- [x] Task 5: Verify build & typecheck via `npm run build` and `npx tsc --noEmit`.

## Test Strategy (§8)

- Update `src/tasks/task-manager-background-notice.test.ts`: Verify `longLived: true` tasks never emit stall notices.
- Update `src/skills/verification-policy.test.ts`: Verify running non-verification command (`git diff`) preserves passing `lastVerification` and allows completion.
- Update `src/agent/process-failure-detector.test.ts`: Verify `run_command` with relevant CLI arguments does not falsely increment drift counter.
- Verification command: `npm test` and `npx tsc --noEmit`.

## Implementation Context (§11)

```yaml
implementation_context:
  task_summary: 'Fix agent-loop auto-interruption, stall watchdog spam on long-lived servers, and verification state clobbering'
  acceptance_criteria:
    - 'Dev servers (longLived: true) never emit stall notices or wake up idle sessions'
    - 'Non-verification commands do not overwrite or invalidate successful test verification records'
    - 'run_command operations do not trigger false RELEVANCE_DRIFT in process failure detector'
    - 'All existing task-manager, verification-policy, and process-failure tests pass'
  evidence_provenance:
    schema_version: 2
    head_commit: '012b2a0eba2c01ef3b68e8d81db42de6f5282272'
    generated_plan_path: 'docs/plans/2026-11-07-gitnexus-plan-agent-loop-interruption-fix.md'
    global_dirty_digest:
      algorithm: 'sha256'
      canonicalization: 'gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records'
      value: '4523c3eb6c994e4ddf9c95e40f62f3b36c0c00335fbfa2c33e060e71f30774b3'
    cited_path_manifest:
      - path: 'src/agent/agent-loop-background-gate.test.ts'
        object_kind: { head: 'regular', index: 'regular', worktree: 'regular', untracked: 'absent' }
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:e95b607b682f15bbc0c6e9bbf91687c66a66809f4a4c12348643fb707fdc8e86'
        index_digest: 'sha256:e95b607b682f15bbc0c6e9bbf91687c66a66809f4a4c12348643fb707fdc8e86'
        worktree_digest: 'sha256:7b39e148039f70ce0f44f7d556af146705af4b491e6171e338362bbf20ba8cf9'
        untracked_digest: 'absent'
      - path: 'src/agent/agent-loop.ts'
        object_kind: { head: 'regular', index: 'regular', worktree: 'regular', untracked: 'absent' }
        state: 'unstaged'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:610c5459982676249104d884347466764c2c0db9600511927a476dc44d2e0281'
        index_digest: 'sha256:610c5459982676249104d884347466764c2c0db9600511927a476dc44d2e0281'
        worktree_digest: 'sha256:fa22f074cb70f51aac8d7cb97ced9630a9ee5567ba0d5bbc0485e4afded636a6'
        untracked_digest: 'absent'
      - path: 'src/agent/process-failure-detector.test.ts'
        object_kind: { head: 'regular', index: 'regular', worktree: 'regular', untracked: 'absent' }
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:36ed4b85c1b1379dc1abb2d8d4ea15df2a6b5881f4dac750973b63c79b5d9f1e'
        index_digest: 'sha256:36ed4b85c1b1379dc1abb2d8d4ea15df2a6b5881f4dac750973b63c79b5d9f1e'
        worktree_digest: 'sha256:3012aa94dd29871f882a0ac796abe31de72eec693e94f05a43247791ccf86771'
        untracked_digest: 'absent'
      - path: 'src/agent/process-failure-detector.ts'
        object_kind: { head: 'regular', index: 'regular', worktree: 'regular', untracked: 'absent' }
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:166dbbe0a62b72b66f959851f5c767aa07c1dbe777c241a4ccdfabc8caa941bb'
        index_digest: 'sha256:166dbbe0a62b72b66f959851f5c767aa07c1dbe777c241a4ccdfabc8caa941bb'
        worktree_digest: 'sha256:151d3a6bf38dbfa2b3040326db8b4221899532ccf120c997e74641b341c24e3c'
        untracked_digest: 'absent'
      - path: 'src/skills/verification-policy.test.ts'
        object_kind: { head: 'regular', index: 'regular', worktree: 'regular', untracked: 'absent' }
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:6c38bec6a12bca6cc0145d707e89d87dd0089eb16a259cde12f5ef582346d52f'
        index_digest: 'sha256:6c38bec6a12bca6cc0145d707e89d87dd0089eb16a259cde12f5ef582346d52f'
        worktree_digest: 'sha256:6f746461c11d16b8c6e80ae79734c22e49d40faf145fc4d79789b3d09a724c56'
        untracked_digest: 'absent'
      - path: 'src/skills/verification-policy.ts'
        object_kind: { head: 'regular', index: 'regular', worktree: 'regular', untracked: 'absent' }
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:42ba76ada7d0bb332f94268327b33057dd76e6958732f1a08fda737f63bdf398'
        index_digest: 'sha256:42ba76ada7d0bb332f94268327b33057dd76e6958732f1a08fda737f63bdf398'
        worktree_digest: 'sha256:109e14193f02bbe87eab3dd1c18ceb46f2d169654b2acca724e61e4db29e7e6d'
        untracked_digest: 'absent'
      - path: 'src/tasks/task-manager-background-notice.test.ts'
        object_kind: { head: 'regular', index: 'regular', worktree: 'regular', untracked: 'absent' }
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:14d96d423a6f93a74e882b28bc0f268d6fdbe69033647d50891874784d242e07'
        index_digest: 'sha256:14d96d423a6f93a74e882b28bc0f268d6fdbe69033647d50891874784d242e07'
        worktree_digest: 'sha256:5b334ded8987b75da54368274cc9ab1190371ee54984815f5ebde63791c16936'
        untracked_digest: 'absent'
      - path: 'src/tasks/task-manager.ts'
        object_kind: { head: 'regular', index: 'regular', worktree: 'regular', untracked: 'absent' }
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:5871741cee433c229615d2b580158da43d57dc562623331f648c03f621ca61d4'
        index_digest: 'sha256:5871741cee433c229615d2b580158da43d57dc562623331f648c03f621ca61d4'
        worktree_digest: 'sha256:8e4f78e38bfa7789c02e1f384ab1b74cee2cb4de5b2884f9e96061175d8f2a19'
        untracked_digest: 'absent'
      - path: 'src/tools/run-command.ts'
        object_kind: { head: 'regular', index: 'regular', worktree: 'regular', untracked: 'absent' }
        state: 'unstaged'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:4dc9a89c916ee0f447058f172305c6f31314848ee35f8270a6ad50cff1b08022'
        index_digest: 'sha256:4dc9a89c916ee0f447058f172305c6f31314848ee35f8270a6ad50cff1b08022'
        worktree_digest: 'sha256:0b8ae2974cc807307049516ff2838a4bc4899f2731d355369d5e08245893fb6b'
        untracked_digest: 'absent'
  primary_symbols:
    - symbol: 'shouldEmitStallNotice'
      file: 'src/tasks/task-manager.ts'
      lines: '59-68'
      role: 'Pure stall predicate determining whether idle background tasks emit notices'
    - symbol: 'recordVerification'
      file: 'src/skills/verification-policy.ts'
      lines: '259-327'
      role: 'Records execution outcome and updates lastVerification state'
    - symbol: 'detectProcessFailure'
      file: 'src/agent/process-failure-detector.ts'
      lines: '221-257'
      role: 'Detects relevance drift during exploration'
  files_to_modify:
    - file: 'src/tasks/task-manager.ts'
      symbols: ['BackgroundTaskOptions', 'BackgroundTask', 'shouldEmitStallNotice', 'TaskManager.startTask']
      intended_change: 'Add longLived option and suppress stall notices for long-lived processes'
    - file: 'src/tools/run-command.ts'
      symbols: ['createRunCommandTool']
      intended_change: 'Pass longLived flag to taskManager.startTask'
    - file: 'src/skills/verification-policy.ts'
      symbols: ['VerificationPolicy.recordVerification']
      intended_change: 'Prevent non-verification commands from overwriting successful verification state'
    - file: 'src/agent/process-failure-detector.ts'
      symbols: ['ProcessFailureDetector.detectProcessFailure']
      intended_change: 'Extract command string for run_command to prevent empty target relevance drift'
  tests:
    - file: 'src/tasks/task-manager-background-notice.test.ts'
      scenarios:
        - 'longLived task idle for >45s → shouldEmitStallNotice returns false'
    - file: 'src/skills/verification-policy.test.ts'
      scenarios:
        - 'Passing test followed by git diff → canComplete() remains allowed'
    - file: 'src/agent/process-failure-detector.test.ts'
      scenarios:
        - 'run_command with valid command → no false RELEVANCE_DRIFT triggered'
  verification_commands:
    - 'npm test -- src/tasks/task-manager-background-notice.test.ts'
    - 'npm test -- src/skills/verification-policy.test.ts'
    - 'npm test -- src/agent/process-failure-detector.test.ts'
    - 'npx tsc --noEmit'
  avoid:
    - 'Do not disable stall detection for finite background commands that legitimately wait on interactive stdin'
    - 'Do not allow failed verification commands (exitCode !== 0) to be ignored if they were intended verification runs'
    - 'Do not bypass verification gates altogether'
```

## Assumptions and Open Questions (§12)

- [assumed] Dev servers like `npm run dev` are started with `longLived: true` (or detected via `isDaemon`/dev-server heuristic) and should not trigger stall notices. Check: verify `run-command.ts` properly tags dev servers.
- [assumed] Harness review suggestions (`git diff`) should gracefully skip git commands when the workspace has no `.git` directory (`fatal: Not a git repository`).

## Definition of Done (§13)

- `longLived: true` background tasks do not trigger idle stall notices or interrupt the agent loop.
- Running non-verification inspection commands (`git diff`, `git status`) after successful tests does not invalidate verification state.
- `run_command` in exploration phase does not trigger false `RELEVANCE_DRIFT` alerts.
- All unit tests pass and `npx tsc --noEmit` succeeds with zero errors.
