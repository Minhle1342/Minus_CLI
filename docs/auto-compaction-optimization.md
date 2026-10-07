# Auto-compaction optimization

## Shared request budget

`resolveRequestBudget` computes the hard and proactive input ceilings after
subtracting the output reserve. Step compaction counts the full request.
Turn compaction uses the same counter with current history and the last
observed system prompt/tools/dynamic context for that session. It refreshes
input/output limits from the current token configuration. This is an estimate
of the next request, not knowledge of its future prompt.

If no request metadata exists (for example, an imported session), the boundary
path falls back to history tokens with an output reserve. The next step will
still count its actual full request before sending it.

## Avoid repeated attempts

Each manager/loop retains one negative-candidate fingerprint, not a growing
cache. An unchanged rejected candidate is not regenerated. Request content,
budget, calibration, compactor configuration, policy or protected context
changes invalidate the fingerprint. Archive failures are never cached as
successful compaction. Protected auto-compaction does not run an identical
second emergency pass.

## Selective active-turn retention

Instructions, mixed messages, unique observations, changed file snapshots,
different read windows, unresolved failures and latest evidence remain pinned.
Only response-only messages with explicit replacements can be unpinned:

- Identical file-read payloads from the same tool, path and arguments.
- Identical successful command payloads from the same command and arguments.

An old observation must also be outside the preserved recent-result window.
Replacement stubs include an archive ID; original payloads are archived before
history replacement. This does not introduce free-form relevance judgments or
permit arbitrary trimming of the active request. Archive caps and oversized
payload policies still apply; originals in the persisted session event log
remain the recovery source for data outside the recall store.

## Verification and benchmark

```powershell
npm run build
node --import tsx --test src/agent/compaction-optimization.test.ts src/agent/auto-compaction-safety.test.ts src/agent/context-budget-manager.test.ts src/agent/completed-turn-compaction-policy.test.ts
node --import tsx src/eval/compaction-optimization-benchmark.ts
```

The local benchmark compares full pinning with selective replacement on twelve
identical snapshots in one active turn. It reports elapsed time, candidate
attempts, token savings, preserved-prefix messages and payload retention.
The fixture reduced the request upper bound from 139,629 to 36,237 tokens,
while retaining the latest snapshot. Timing varies by machine and load.

This synthetic result is **not** evidence of real-provider cache hit rates or
semantic LLM task accuracy. Separate tests verify exact archive recall after
restarting the store for the fixture-sized payloads.

Auto-compact step remains enabled. Disabling it would require retaining request
budget checks and refusing oversized requests rather than truncating context.
