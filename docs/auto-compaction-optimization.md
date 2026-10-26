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

## Trigger principles

Compaction is evaluated on one normalized budget: the calibrated upper bound of
the whole request against the provider window minus the output reserve. The
proactive ceiling is `usableInputTokens * triggerRatio` (default `0.8`) minus a
growth reserve. The earlier design multiplied a 75% cost target by a trigger
ratio, so compaction fired near half the provider window while headroom
remained; there is no second ratio applied to an already-reduced target.

- **Single normalized ratio.** A request compacts when its upper bound exceeds
  the proactive ceiling, a durable phase boundary justifies a rewrite, or tool
  observations have degraded. Hard overflow (`upperBoundTokens >
  usableInputTokens`) always compacts regardless of mode or provider.
- **Hysteresis.** After a successful rewrite the manager records the resulting
  upper bound and does not rewrite again until the request grows past that
  level by `hysteresisRatio` (default `0.1`). Masking is idempotent, so without
  this the same trigger would fire on every step and repeatedly break the cache
  prefix. Hard overflow bypasses the cooldown.
- **Growth reserve (predictive).** The manager tracks the exponentially weighted
  growth of history tokens between steps and subtracts `1.5 × EWMA` from the
  proactive ceiling, capped at `growthReserveCapRatio` (default `0.25`) of the
  usable window. A large tool observation therefore triggers one pass before it
  lands past the ceiling and forces an emergency pass.
- **Structural signals are archive-only.** At a completed-turn boundary, a
  growing backlog of turns or observation characters can trigger an
  archive-and-checkpoint pass, but only token pressure may rewrite model-facing
  history (see [Completed-turn auto compaction](completed-turn-compaction.md)).
- **Cache-aware materiality.** A rewrite must save at least 512 tokens and 10%
  of the request. Once history occupies at least 75% of the usable window, the
  required share rises to 20%, because a large cached prefix is worth more than
  a marginal rewrite returns. The materiality gate is skipped only when the
  request would otherwise overflow.
- **Non-history telemetry.** `nonHistoryPressure` reports when system prompt,
  tools and dynamic context alone consume `nonHistoryShareThreshold` (default
  `0.4`) of the usable window. It is telemetry, not a rewrite trigger: trimming
  those surfaces can drop tool schemas and instructions.
- **Hard gate in every mode.** `legacy`, `shadow`, `enforce` and `auto` all
  count the real request, attempt compaction when over the ceiling, and return
  `CONTEXT_BUDGET_UNSATISFIABLE` rather than sending an oversized request. The
  emergency pass (completed turns, observation masking, active-text reduction)
  runs before that verdict, so `auto` no longer skips recovery for an
  unrecognized provider.

Environment overrides:

| Variable | Default | Range | Effect |
| --- | --- | --- | --- |
| `MINUS_REQUEST_COMPACTION_RATIO` | `0.8` | `0.5`–`0.95` | Proactive ceiling before the growth reserve. |
| `MINUS_COMPACTION_HYSTERESIS_RATIO` | `0.1` | `0`–`0.5` | Required regrowth after a rewrite before the next one. |
| `MINUS_COMPACTION_GROWTH_RESERVE_RATIO` | `0.25` | `0`–`0.5` | Cap on projected growth reserved from the ceiling. |
| `MINUS_NON_HISTORY_SHARE_THRESHOLD` | `0.4` | `0.1`–`0.95` | Share of the window reported as non-history pressure. |

Empty or non-numeric values fall back to these defaults; numeric out-of-range
values are clamped to the documented range. Each agent loop resets hysteresis
and growth state when it switches sessions.

## Avoid repeated attempts

Each manager/loop retains one negative-candidate fingerprint, not a growing
cache. An unchanged rejected candidate is not regenerated. Request content,
budget, calibration, compactor configuration, policy or protected context
changes invalidate the fingerprint. Archive failures are never cached as
successful compaction. Protected auto-compaction does not run an identical
second emergency pass. A successful rewrite starts the hysteresis cooldown
instead of allowing the next step to repeat the same rewrite.

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
