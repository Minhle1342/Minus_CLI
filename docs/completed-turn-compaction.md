# Completed-turn auto compaction

After a turn closes, automatic turn-window compaction requires all of:

1. Compaction is enabled, no turn is open, and no tool call is pending.
2. There are more completed turns than `preserveCompletedTurns` (default 4).
3. Token pressure reaches 60% of the usable input budget (`maxInputTokens`
   minus the output reserve). The measured value is the full request upper
   bound when request metadata exists; otherwise it falls back to history
   tokens or the compactor's `maxTotalHistoryTokens`.
4. The candidate synopsis saves at least 512 tokens **and** 10% of the measured
   original request (same fallback). Once history occupies at least 75% of the
   usable window, the required share rises to 20% to protect a large cached
   prefix.

Only then are older turns archived and model-facing history rewritten. The
newest configured number of completed turns remains intact. Skipped attempts
do not throw away archived turns, emit an auto-compaction notice, or rewrite
history.

Turn count and observation character volume identify backlog, but they are not
sufficient to rewrite history. When they exceed their limits without token
pressure, the boundary performs an archive-only checkpoint: archiveable
observations are stored for recall and model-facing history stays
byte-identical. This keeps structural signals from breaking the prefix cache
while still preventing unarchived evidence from accumulating.

Environment overrides:

| Variable | Default | Valid range |
| --- | --- | --- |
| `MINUS_COMPLETED_TURN_COMPACTION_RATIO` | `0.6` | `0.01`–`1` |
| `MINUS_COMPLETED_TURN_MIN_TOKENS_SAVED` | `512` | `1`–`Number.MAX_SAFE_INTEGER` |
| `MINUS_COMPLETED_TURN_MIN_SAVINGS_RATIO` | `0.1` | `0`–`1` |
| `MINUS_MAX_UNCOMPACTED_TURNS` | `4` | `1`–`50` |
| `MINUS_MAX_UNCOMPACTED_CHARS` | `40000` | `1000`–`1000000` |

Empty, non-finite or out-of-range values fall back to defaults. Overrides are
read at each completed-turn boundary. Request-budget compaction remains
independent and can still protect the provider limit before model requests.
