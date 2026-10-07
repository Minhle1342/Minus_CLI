# Evidence-based submission readiness

The root agent can enter `ready_to_submit` only after an actual answer draft
passes existing final-answer gates and the shared submission preflight. A
passing build or the model saying “done” alone does not trigger this state.
No extra LLM judge or preflight tool call is introduced.

`src/agent/submission-readiness.ts` shares evidence, verification-policy and
grounding-auditor checks between the draft and the real submit path. Runtime
fills omitted file/verification metadata from turn-scoped observations without
rewriting the answer or overriding explicit fields. A build is not relabelled
as a passing test suite.

## Tool surface and recovery

- Ready: keep the schema list stable, but allow only `submit_solution` through
  provider tool choice and a matching runtime ToolScope (including control off).
- Gemini uses the existing `ANY` + allowed function names support.
- OpenAI-compatible and Anthropic adapters force the named submit function and
  disable parallel calls in this state.
- Rejected submissions invalidate readiness and restore ordinary routing.
- Successful submission retains the existing auto-finalization/tool lock.
- An unchanged, fully validated draft also auto-finalizes for edit tasks, even
  when concise, avoiding a redundant model call to restate the accepted answer.
  Changed summaries keep the existing finalization path.

The bounded turn-local ticket is invalidated by new observed tool outcomes,
user input (including queued requests), plan changes, pending calls, active agents, or changed contents of
tracked mutation artifacts. Prompt bookkeeping alone does not invalidate it.
The ticket is checked again before executing submission to catch state changes
while the model was generating its payload. Final audit is never bypassed.
Unreadable tracked artifacts prevent readiness rather than acting as an unchanged fingerprint.

## Limits

This is eligibility under the existing validators, not a proof of semantic
correctness. It does not introduce a new acceptance-criterion grader or infer
that a project is complete from test success. Existing plan/critic rules remain
in force; untracked external workspace changes are not covered by artifact
hashing. Payload changes can still be rejected and must recover normally.

Full schemas remain in context; callable-tool restriction is not schema-token
elimination. Named-tool support depends on the provider endpoint. Runtime
authorization remains authoritative even if a provider ignores tool choice.
Live latency/cache improvements require provider benchmarks; scripted tests
only prove no extra judging round trip and preserved schema prefixes.

## Tests

```powershell
npm run build
node --import tsx --test src/agent/submission-readiness.test.ts src/agent/submission-runtime-lock.test.ts src/agent/submission-stream-lock.test.ts src/llm/submission-tool-choice.test.ts src/agent/read-only-submit.test.ts src/agent/completion-policy.test.ts src/agent/submit-autofinalize.test.ts src/tools/submit-solution.test.ts src/llm/dynamic-tool-masking.test.ts
```
