# Compaction Pareto control plane

The harness now budgets the complete model request after the system prompt, tool schemas, history, dynamic context, and output reserve are known. `ContextBudgetManager` is the only request-time compaction gate. This avoids conflicting decisions from separate history-only gates.

## Rollout modes

- `legacy` runs the existing compaction policy through the unified gate.
- `shadow` sends the legacy projection and records the enforced candidate's token upper bound.
- `enforce` sends the hard-budget projection. If even pinned input exceeds the provider ceiling, the request stops with `CONTEXT_BUDGET_UNSATISFIABLE` instead of relying on a provider rejection.

Set `MINUS_CONTEXT_MANAGEMENT_MODE` to choose the mode. `MINUS_REQUEST_COMPACTION_RATIO` controls the proactive trigger. The 24K working-memory target remains a cost target; the provider's configured input window remains the hard safety ceiling.

## State and evidence

Each compaction stores a versioned `CompactionStateV1` in the append-only session event log. It preserves the objective, decisions, file references, verification results, archived turn IDs, masked observation IDs, a source fingerprint, and a generation counter. Entries use stable content hashes so repeated compactions merge evidence instead of recursively summarizing prior summaries.

Verification is admitted only from paired `run_command` calls and results with an observed success or failure. Context Guardian no longer inserts default claims such as “all tests passing,” a completed task, an architecture decision, or a resolved error when no matching evidence exists.

## Token accounting

The local counter serializes the whole provider-neutral request and applies a conservative error margin. It calibrates that margin from each provider's observed prompt-token usage. The counter exposes whether the value is a hard provider count; the current local implementation reports an estimate with an upper bound.

Compaction first masks old observations and rolls old turns into a structured synopsis. Enforced mode then applies bounded observation stubs, trims old assistant narration, and windows an existing rolling synopsis. User input and tool call/result pairing remain intact.

## Pareto gate

Run the quick diagnostic with:

```text
npm run benchmark:compaction
```

It intentionally has only 36 paired samples and must report `INCONCLUSIVE` for a one percentage point non-inferiority margin.

Run the powered synthetic gate with:

```text
npm run benchmark:compaction:gate
```

The gate covers English, Vietnamese, mixed-language facts, early/middle/late evidence, four payload sizes, and four consecutive compaction generations. It generates 648 paired variants, above the registered minimum of 619 samples. A policy is selectable only when:

- the one-sided 95% paired-bootstrap lower bound is at least -0.01;
- no sample exceeds the hard request budget;
- no sample records false verification or an invariant failure; and
- the candidate is not Pareto-dominated on quality and input cost.

The synthetic gate validates retention and safety mechanics. Production rollout should remain in `shadow` until representative live coding tasks meet the same gate; synthetic variants do not establish external task accuracy by themselves.
