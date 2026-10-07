# Completed-turn auto compaction

After a turn closes, automatic turn-window compaction requires all of:

1. Compaction is enabled, no turn is open, and no tool call is pending.
2. There are more completed turns than `preserveCompletedTurns` (default 4).
3. Serialized history tokens occupy at least 60% of the active model's input
   budget (fallback: the compactor's `maxTotalHistoryTokens`). This is a
   history-only pressure estimate, not the full request including tools/system prompt.
4. The candidate synopsis saves at least 512 tokens **and** 10% of history.

Only then are older turns archived and model-facing history rewritten. The
newest configured number of completed turns remains intact. Skipped attempts
do not archive turns, emit an auto-compaction notice, or rewrite history.

Environment overrides:

| Variable | Default | Valid range |
| --- | --- | --- |
| `MINUS_COMPLETED_TURN_COMPACTION_RATIO` | `0.6` | `0.01`–`1` |
| `MINUS_COMPLETED_TURN_MIN_TOKENS_SAVED` | `512` | `1`–`Number.MAX_SAFE_INTEGER` |
| `MINUS_COMPLETED_TURN_MIN_SAVINGS_RATIO` | `0.1` | `0`–`1` |

Empty, non-finite or out-of-range values fall back to defaults. Overrides are
read at each completed-turn boundary. Request-budget compaction remains
independent and can still protect the provider limit before model requests.
