# Git workflow guidance

The Harness reconstructs `Inspect → Branch → Implement → Commit → Sync → PR → Done`
from paired session tool calls/results. Stages outside the current human request's
authorization are skipped. Creating a branch, editing code, committing, pushing,
and creating a PR are separate permissions. Generated plan steps do not grant them.

| Stage | Required evidence |
| --- | --- |
| Inspect | Successful status, unstaged diff, and staged diff results |
| Branch | Successful requested branch operation; creation, switching, renaming, and deletion are distinguished |
| Implement | Successful edits followed by relevant successful verification after the latest edit, plus completion of planned implementation tasks; requested merge/rebase/undo operations also need successful results |
| Commit | Successful commit when requested; staging alone completes only a staging-only request |
| Sync | Successful results for every requested fetch/pull/push operation |
| PR | Successful creation with a returned PR URL, or successful update; review/preparation can finish with a successfully recorded findings/submission tool result |

`control/decision` records the current stage, authorized operation types, skipped
stages, missing evidence, and result sequence numbers supporting completed stages.
Only the current stage's playbook and state guidance enter the model context.
Prompt gating `off` disables that guidance; it does not disable runtime ordering checks.

The runtime checks each call again, including calls within the same response batch.
An out-of-order Git mutation returns `GIT_WORKFLOW_STAGE_BLOCKED` before execution.
The existing Git command, path, branch, workspace, and permission guards still apply.
Workflow state does not grant broader permissions or replace those guards.

Blocked, failed, cancelled, unknown, timed-out, dry-run, and background-start results
do not complete stages. Background evidence needs terminal completion matched to
the original task ID and command. A shell's final exit code is used as evidence only
for simple commands or an `&&` chain without substitution/obfuscation. Use separate
calls for different stages. Later edits invalidate implementation verification and
subsequent commit/sync/PR progress.

State is replayed from durable outcomes after the current human request, retaining
progress across internal retries without carrying authorization into a new task.
Natural-language authorization uses existing intent detection and conservative
rules; it is not an unrestricted interpretation of every possible phrasing.
Missing or ambiguous evidence leaves the stage pending; no artificial edits,
automatic rollback, forced push, or unsolicited authorization are inferred.
