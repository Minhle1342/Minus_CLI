# GitNexus Engineering Plan

> Task: Upgrade LLM behaviour in the IMPLEMENT and VERIFY phases of Minus CLI — guidance, enforcement, and web-researched practice.
> Evidence verified at commit 35979bc81eb7efa2eb1e96abeed7936473296940; GitNexus index refreshed this session (`node .gitnexus/run.cjs analyze --index-only --pdg`, 35.8s, 73,716 nodes / 193,553 edges / 633 flows; analyzer 1.6.12, runner identity current).
> Evidence provenance schema 2 computed by `evidence-provenance.mjs snapshot`: global dirty digest `0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd`; 16 cited paths, all `clean`; exact generated plan path excluded. Publication used a plain write because the helper's `write-plan` command refuses win32 (no `O_DIRECTORY`/`O_NOFOLLOW`); no digest was fabricated. See §11/§12.

---

## 1. Objective

Make the model behave better — not merely read better — in the two phases where correctness is decided:

- **IMPLEMENT**: reproduce before fixing (bugfix/security), make the smallest coherent mutation with canonical tools (`replace_text` for surgical edits, `write_file` for new/overwritten files), never weaken tests to get green, run the cheapest falsifying check via `run_command` after each mutation batch.
- **VERIFY**: prove freshness (check after the last edit), map every claim to an exact `run_command` + scope + observed outcome, audit the diff (`run_command "git diff"`) for unintended damage, show fail→pass for bugfix/security, and use an independent check (such as subagent review when delegation intent is present) when one is available.
- **Enforcement**: align the runtime gates with that guidance, closing the one real gap — a post-fix green run currently satisfies the bugfix reproduction requirement on its own (`completion-evidence.ts:313`), so "no reproduction" bugfixes can pass.
- **Alignment with Streamlined Tool Suite**: fully harmonized with `2026-11-06-gitnexus-plan-streamline-agent-tools-suite.md` — assumes the 4 core canonical tools (`run_command`, `read_file`, `replace_text`, `write_file`) and intent-gated subagents/web. Does not mandate or assume deprecated standalone tools (`list_files`, `search_text`, `delete_file`), referencing `run_command` for exploration/search/diff and `read_file` for inspection.
- **Measurement**: extend the existing wording A/B harness so the change is validated against the old prompt, not asserted.

Scope is the guidance text, the risk-tiered verify playbook, one targeted gate rule, tests, and the A/B harness. No new subsystem, no new tool.

---

## 2. Current Behaviour

[verified] Phase guidance is a dynamic T3 tail, never part of the KV-cache-stable system prompt (`src/llm/sections/phases.ts:5-9`). `resolvePhaseDynamicGuidance` returns a constant per phase; `verify` additionally appends a risk-tiered playbook (`phases.ts:117-120`).

[verified] `agent-loop.ts:2368` calls it with `{taskClass, risk, reversibility, hasValidatedHypothesis, hasSupportedHypothesis, evidenceSufficient, evidenceScore, evidenceThreshold}`; at `agent-loop.ts:2612` the result is concatenated with `VerificationPolicy.formatVerificationGuidance(...)` and arbitrated as one dynamic block at priority 1.5 (`dynamic-context-arbiter.ts:304-307`).

[verified] `PhaseGuidanceOptions.hasUnverifiedChanges` exists but is never passed by any caller — the dynamic-option surface has room without new wiring.

[verified] `resolveVerifyPlaybookPrompt` (`src/llm/sections/tools.ts:103-111`) tiers by risk: R0/R1 → inspect state; R2 → changed-code tests + `git diff`; R3+ → `git diff` then "execute verification test command". The R3+ branch is not stronger than R2 and never mentions scope, freshness, or fail→pass.

[verified] Runtime boundaries already exist and are durable: `recordImplementationCompleted` / `recordVerificationOutcome` (`src/agent/phase-lifecycle.ts:307-354`) bind completion to `latestMutationSeq`; `getPhaseAuthorityState` forces `verify` only when `implementationCompleted` matches that seq (`phase-lifecycle.ts:97-99`); `VerificationPolicy.canComplete()` enforces required tier and impacted suites; `CompletionEvidenceGate` rejects unsupported final-answer claims.

[verified] The reproduction rule is deliberately relaxed today: `hasReproProof = options.hasReproduction === true || executions.some(...'reproduction') || verifications.length > 0` (`src/agent/completion-evidence.ts:313`). A post-fix green check therefore satisfies a bugfix with no pre-fix failure ever observed.

---

## 3. Relevant Architecture

```text
AgentLoop (src/agent/agent-loop.ts)
  ├─ 2368  resolvePhaseDynamicGuidance(phase, options)      ← dynamic T3 guidance
  ├─ 2612  phaseGuidance + verificationPolicy.formatVerificationGuidance()
  ├─ 2640  DynamicContextArbiter.arbitrate(...)              ← token budget, priority 1.5
  ├─ 4726  captureCommandBaseline()  (pre-edit observation of the same command)
  ├─ 4745  recordImplementationCompleted() + recordVerificationOutcome()
  └─ 4755  verificationPolicy.canComplete()                  ← tier / impacted-suite gate

Phase lifecycle (src/agent/phase-lifecycle.ts)
  implement ──(verification command after latest mutation)──► verify
  verify ──(failed or new mutation)──► implement            (durable events, seq-bound)

Policy layers (all existing)
  VerificationPolicy (src/skills/verification-policy.ts)  tier ladder, pending suites, repair budget
  CompletionEvidenceGate (src/agent/completion-evidence.ts) claim ↔ observed execution
  StepPromptPolicy (src/agent/step-prompt-policy.ts)       per-step playbook selection
  Prompt sections (src/llm/sections/*.ts, src/llm/prompts.ts)  T0/T2 static + T3 dynamic
```

Two constraints shape every change: dynamic sections must stay **≤500 tokens each** (`prompt-sections-trim.test.ts:106-120`), and the phase guidance must remain a pure function of its options so the KV-cache prefix never changes.

---

## 4. GitNexus Findings

- [graph] `impact recordVerificationOutcome --direction upstream --depth 3` → 3 impacted, **risk LOW**, 1 direct dependent (`agent-loop.ts`), process `runInternalWithCircuitBreakerRetry` (7 affected processes, total 14 hits). Callers were also confirmed by text search.
- [graph] `impact resolvePhaseDynamicGuidance --direction upstream --depth 3` → `risk: UNKNOWN`, 0 callers, with the index's own warning that a re-export can hide callers.
- [verified] The graph/source disagreement is real but benign: `src/llm/prompts.ts:40,86` re-exports the function, and the callers are `agent-loop.ts:2368` plus `request-analysis.test.ts` and `policy-guidance-regression.test.ts`. **Treat the graph zero as unresolved, not as "unused"** — it is reachable and user-facing.
- [graph] `codegraph_explore` blast radius: `SECTION_PHASE_VERIFY_GUIDANCE` 3 callers (`prompts.ts`, `phases.ts`), `resolveVerifyPlaybookPrompt` 6 callers (`phases.ts`, `step-prompt-policy.ts`), `StepPromptPolicy` 11 callers, `TaskPhase` 21 callers.
- [verified] Related tests that pin the current wording: `src/llm/prompt-sections-trim.test.ts:86-94`, `src/agent/request-analysis.test.ts:142-155`, `src/agent/policy-guidance-regression.test.ts:24-29`, `src/agent/prompt-engineering-patterns.test.ts:87-89`, `src/agent/submission-readiness.test.ts:11-21`.
- [verified] Existing test suites for the gates: `src/agent/completion-policy.test.ts`, `completion-evidence.blocked.test.ts`, `completion-evidence.command.test.ts`, `dynamic-verification.test.ts`, `verify-gates.test.ts`, `verification-coverage.test.ts`, `policy-consistency.test.ts`.

### 4.1 External practice evidence (web)

| Source | Date | Adopted rule |
| --- | --- | --- |
| Anthropic, *Best practices for Claude Code* | 2026-10-30 | Give the agent **a check it can run**; TDD: write the test, see it fail, then implement; verify with an independent reviewer so the implementation is not overfit to its own tests. |
| Anthropic, *Building verification loops in Claude Code with skills* | 2026-07-22 | Treat the session as context → act → **verify → loop back**; act on tool error codes/warnings; list exact build/test commands in the agent config. |
| Anthropic research, *Claude Code best practices* | — | "keep going until all tests pass", **do not modify the tests** to force a pass. |
| Vonage, *Beyond Vibe Coding: Best Practices in 2026* | 2026 | Review loop: agent writes/updates tests → runs the suite → second reviewer red-teams the diff; self-review prompt reports findings **before** editing. |
| Critique, *Best Coding Agent Verification Tools 2026* | 2026 | "No single system gets to grade its own homework": self-check, then an independent verifier, with CI authoritative for deterministic controls. |
| *Seven Rules for Reliable Coding with LLM Agents* (hard verification loop) | 2026 | Every new test must be **shown to fail before passing**; add postcondition checks after mass edits. |
| Huang et al., *LLMs Cannot Self-Correct Reasoning Yet* (ICLR 2024) | 2023-10 | Intrinsic self-correction without external feedback is unreliable and can degrade output — verification must come from **executed evidence**, not self-review. |
| OpenAI, *A Practical Guide to Building Agents* | 2025-04 | Layered guardrails; escalate/stop on repeated failure; rules that cannot have exceptions belong in enforcement, not prose. |

These justify the split below: **prose where judgement is needed, a gate where the rule is mechanical**.

---

## 5. Statement-Level PDG Findings

[graph] `impact recordVerificationOutcome --mode pdg --direction upstream --line 335` (`pdg-intra-procedural`, 3 statements):

- `phase-lifecycle.ts:333` `const mutation = getTurnCompletionState(...)` and `:334` `(!mutation.hasMutations)` gate the whole function.
- `:326` (signature) is the enclosing seed. The `phase/verificationFailed` branch is entered only after a mutation exists.
- **Planning implication:** freshness is `latestMutationSeq`-scoped. Any new rule must be evaluated inside this ordering, not against wall-clock or "last command".

[graph] `impact resolvePhaseDynamicGuidanceUncached --mode pdg --direction upstream --line 120` (2 statements, lines 87/91):

- The `verify` arm is a pure switch branch over `phase` returning a string concat with `resolveVerifyPlaybookPrompt(risk)`. No state mutation, no side effects.
- **Planning implication:** guidance changes are behaviour-only; they cannot corrupt lifecycle state. They can still blow the token budget or break wording tests.

[verified] **Failure is not "verification" evidence in the current classifier:** `classifyToolEvidence` returns `[]` for any failed result (`completion-evidence.ts:156`) and only classifies `run_command` as `verification` when `exitCode === 0` and outcome `succeeded` (`:160-168`). A fail→pass rule therefore cannot look for a pre-fix `verification` kind; it must test `isToolResultFailure(payload)` **and** `isVerificationCommand(extractCommandString(...))` on the pre-mutation execution. This is the single most important implementation constraint in this plan.

---

## 6. Proposed Changes

### C1 — Rewrite IMPLEMENT guidance (behaviour, not prose volume)

- **File / symbol:** `src/llm/sections/phases.ts` → `SECTION_PHASE_IMPLEMENT_GUIDANCE`.
- **Responsibility:** tell the model what a coherent mutation sequence looks like.
- **Behavioural change:** add four rules, keep the existing canonical tool directives (`replace_text` for surgical edits, `write_file` for new/overwritten files) and `FILE_MUTATION_SAFETY_RULE`:
  1. smallest coherent change; no speculative refactor of adjacent code;
  2. **never weaken verification** — do not delete, skip, or loosen tests/assertions unless the user asked; if a test is wrong, say so;
  3. after each coherent mutation batch, run the cheapest check that can falsify it via `run_command` (affected test / typecheck / lint) before widening scope;
  4. bugfix/security only (derived from `options.taskClass`): observe the failing check or a minimized reproduction before editing (using `run_command` or reproduction script) and keep that command for the post-fix run.
- **Constraints:** ≤500 tokens; no `${}` interpolation except the existing macro; must not restate `formatVerificationGuidance` freshness text; aligns with the 4-canonical-tool suite.

### C2 — Rewrite VERIFY guidance

- **File / symbol:** `src/llm/sections/phases.ts` → `SECTION_PHASE_VERIFY_GUIDANCE`.
- **Behavioural change:** keep the existing `- Scope:` line verbatim (it is asserted in tests) and add:
  - **fresh** — the decisive check runs via `run_command` after the last edit; an earlier green run is stale;
  - **mapped** — each claim names the exact `run_command` execution, its scope, and the observed outcome; a partial, blocked, dry-run, background-start, or non-zero run is not a pass;
  - **honest** — a failing or unavailable check is reported with what remains unverified;
  - **diff audit** — `run_command "git diff"` for unintended files, debug leftovers, secrets, removed error handling, and tests weakened to pass;
  - **bugfix/security** — show fail→pass on the same `run_command` invocation, or state why reproduction was impossible;
  - **independent check** — when a subagent/review tool is available (under delegation intent), ask it to falsify (find a breaking input), not to approve.
- **Constraints:** ≤500 tokens; keeps "skip unrelated suites" and "Widen to the full suite only when the risk or the user requires it" (test-asserted).

### C3 — Make the risk playbook monotonic

- **File / symbol:** `src/llm/sections/tools.ts` → `resolveVerifyPlaybookPrompt`, `TOOL_PLAYBOOK_PROMPTS`.
- **Behavioural change:** R0/R1 unchanged (`verify state`). R2 = changed-code tests → `git diff` → report command/scope/outcome. **R3+ becomes the strongest**: fail→pass for bugfix/security, changed-code tests + impacted callers, diff audit, report exact evidence. Today R3+ is not stronger than R2.
- **Dependencies:** called from `phases.ts:120` and `step-prompt-policy.ts:289`; tests in `request-analysis.test.ts:142-155`.

### C4 — Supply the dynamic facts the guidance needs

- **File / symbol:** `src/llm/sections/phases.ts` → `PhaseGuidanceOptions` + `resolvePhaseDynamicGuidanceUncached`; `src/agent/agent-loop.ts:2368`.
- **Behavioural change:** add `hasReproduction?: boolean` to `PhaseGuidanceOptions` and pass `this.verificationPolicy.hasReproduction()` (`verification-policy.ts:131`) from the existing call at `agent-loop.ts:2368`. Render one dynamic line for bugfix/security: no reproduction yet → say to observe the failing check first; reproduction recorded → confirm and point at the post-fix run.
- **Constraints:** no new state, no new session events, pure string output. **The cache key enumerates fields explicitly — the new field must be added to the `cacheKey` array in `resolvePhaseDynamicGuidance`, or a cached branch will leak across turns.**

### C5 — Close the reproduction gap in the completion gate

- **File / symbol:** `src/agent/completion-evidence.ts` → `CompletionEvidenceGate.evaluate`.
- **Behavioural change:** for `taskClass === 'bugfix' | 'security'` with mutations, replace `|| verifications.length > 0` with a real pre-fix observation:

```ts
const firstMutationSeq = mutations[0]?.result.seq ?? Number.POSITIVE_INFINITY;
const preFixFailure = executions.some((item) =>
  item.result.seq < firstMutationSeq
  && isToolResultFailure(item.payload)
  && !isCommandOutcomeBlocked(item.payload)
  && (item.toolName === 'run_test_suite'
    || (item.toolName === 'run_command'
      && isVerificationCommand(extractCommandString(item.args, item.payload)))));
const hasReproProof = options.hasReproduction === true || preFixFailure
  || executions.some((e) => e.kinds.includes('reproduction'));
```

- **Exemptions preserved:** `userExplicitlyExemptsTesting`, external blockers, non-executable-only mutations. Add `MINUS_FAIL_TO_PASS_GATE=off|0|false|disabled` kill-switch following the file's existing `isCompletionEvidenceGateEnabled` convention.
- **Why here:** the gate already owns claim↔evidence and already imports every helper used above; `captureCommandBaseline` remains for regression attribution, not duplication.

### C6 — Measure the wording change instead of asserting it

- **File:** `src/eval/prompt-wording-ab-benchmark.ts`.
- **Behavioural change:** add two scenarios scored on observable calls, using the existing old-ref/new-variant mechanism:
  - `bugfix-reproduce`: request "Fix the failing parser test" with a stub tool result; pass only if a verification command is called **before** the first mutation.
  - `verify-freshness`: after an edit, pass only if a check is re-run after the edit and the final answer cites the command + scope.
- **Constraints:** live-model, `GEMINI_API_KEY`, free-tier throttle already implemented; keep out of CI (same as today).

---

## 7. Implementation Sequence

1. **C1 + C2 (text only).** Edit the two constants; keep the asserted phrases. Run `npm run build` and the two wording tests. Tree stays coherent: behaviour changes only through prompt text.
2. **C3 (playbook).** Rewrite `resolveVerifyPlaybookPrompt`; update `request-analysis.test.ts` expectations in the same step.
3. **C4 (dynamic facts).** Add `hasReproduction` to `PhaseGuidanceOptions`, render the extra line, pass it from `agent-loop.ts:2368`. Add the cache-key field so the guidance cache cannot serve a stale branch.
4. **C5 (gate).** Implement the pre-fix check + env switch; add `src/agent/completion-evidence.fail-to-pass.test.ts`; re-run `npm run test:completion` and any failing `completion-policy` cases. Update, do not delete, any existing test that encoded the relaxed rule.
5. **Wording regressions.** Extend `policy-guidance-regression.test.ts` (guidance must contain the four new rules; R1 must still say `verify state`) and `prompt-sections-trim.test.ts` (budget + single-source macros).
6. **C6 (A/B).** Add the two scenarios; run locally with `GEMINI_API_KEY` and `--scenario=bugfix-reproduce --rounds=5` (and the verify scenario). Record pass-rates old vs new in the PR description; do not gate CI on it.
7. **Full verification.** `npm run build`, `npm run test:completion`, `npm run test:prompt-gating`, `npm test`. Regenerate no golden/fingerprint artifacts — none are touched by this change.

Each step leaves the tree buildable and testable; steps 1–3 are independent of 4.

---

## 8. Test Strategy

**Update (wording pins).**
- `src/llm/prompt-sections-trim.test.ts` — keep/extend the verify-scope assertions (`:86-94`), keep the 500-token budget loop (`:106-120`), add implement-guidance assertions for "never weaken" and "before editing".
- `src/agent/request-analysis.test.ts:142-155` — new playbook expectations: R3+ contains fail→pass and diff audit; R2 ordering tests → `git diff` → report.
- `src/agent/policy-guidance-regression.test.ts` — R1 still matches `/verify state/`; add: verify guidance contains fresh/mapped/honest; implement guidance for `taskClass:'bugfix'` contains reproduction-before-edit.
- `src/agent/prompt-engineering-patterns.test.ts:87-89` — still asserts implement guidance equals the exported constant (no behavioural change needed).

**Add (behaviour).**
- `src/agent/completion-evidence.fail-to-pass.test.ts` — scenarios (input → action → expected):
  1. bugfix, failing `npm test` before mutation, mutation, passing `npm test` after → allowed;
  2. bugfix, no pre-fix run, mutation, passing `npm test` after → **blocked**, reason names reproduction;
  3. bugfix, blocked pre-flight before mutation → not counted as reproduction; post-fix pass alone still blocked;
  4. feature/refactor, same shape as (2) → **allowed** (rule is bugfix/security-only);
  5. bugfix with `userExplicitlyExemptingTests` (`/no-verify`) → allowed;
  6. kill-switch `MINUS_FAIL_TO_PASS_GATE=off` → allowed;
  7. docs-only mutation → allowed without reproduction.
- `src/agent/phase-lifecycle.test.ts` — no change expected; run as regression proof that C5 does not disturb seq-bound freshness.

**Verification commands (exist and are runnable, verified in `package.json`).**
```bash
npm run build
npm run test:completion
npm run test:prompt-gating
npm test                      # node --import tsx --test "src/**/*.test.ts"
```

**Edge cases explicitly covered:** blocked/timeout/dry-run commands (not evidence), background-started test (not a pass), test-file weakening (guidance + diff audit; no hard gate — see §12), monorepo command selection (`--filter`, `-k`, `--testNamePattern` already inferred by `inferTier`).

---

## 9. Risk and Impact Analysis

**Direct (depth-1) dependents that must keep compiling and behaving:**

| Dependent | Change that reaches it | Mitigation |
| --- | --- | --- |
| `agent-loop.ts:2368` (`resolvePhaseDynamicGuidance`) | C1, C2, C4 | Options object is extended, not reshaped; no signature break |
| `agent-loop.ts:2612` (`formatVerificationGuidance` concat) | C1/C2 wording | No duplication of freshness text; token budget asserted |
| `agent-loop.ts:4745-4756` (`recordVerificationOutcome`) | C5 evaluated separately | Gate runs in `CompletionEvidenceGate`, not in lifecycle; seq logic untouched |
| `phases.ts:120` + `step-prompt-policy.ts:289` | C3 | Single source in `tools.ts`; both call the same resolver |
| `prompts.ts:40,86` re-export | C1–C4 | Exports unchanged |
| Wording tests (§8) | C1–C3 | Updated in the same step as the text |

**Risks.**
- **Over-blocking (highest).** A true bugfix whose failure cannot be reproduced locally now fails completion. Mitigations: exemptions (user `/no-verify`, external blockers, non-executable-only mutations), env kill-switch, bugfix/security only, and a recovery prompt that names the missing step. [inferred]
- **Prompt budget.** Two rewrites could breach 500 tokens/section and get truncated by the arbiter (`phaseGuidance` is priority 1.5 and prunable to zero only as last resort). Asserted by test; keep prose imperative and deduplicated.
- **Regression tests encode old wording.** Deliberate: update them in the same step; never weaken an assertion to fit new prose.
- **A/B is live and flaky** (free-tier 429/503). Results are advisory; do not gate CI. [assumed]
- **KV-cache.** All edits are T3 dynamic text; the static prefix and tool schemas are unchanged, so cache stability is preserved. [verified via `DEFAULT_PROMPT_SECTIONS` tier ordering test]

---

## 10. Files Expected to Change

| File | Symbols | Reason |
| --- | --- | --- |
| `src/llm/sections/phases.ts` | `SECTION_PHASE_IMPLEMENT_GUIDANCE`, `SECTION_PHASE_VERIFY_GUIDANCE`, `PhaseGuidanceOptions`, `resolvePhaseDynamicGuidanceUncached` | C1, C2, C4 |
| `src/llm/sections/tools.ts` | `resolveVerifyPlaybookPrompt`, `TOOL_PLAYBOOK_PROMPTS.verifyDiff` | C3 |
| `src/agent/agent-loop.ts` | `runInternal` (phase guidance call, ~2368) | C4 wiring |
| `src/agent/completion-evidence.ts` | `CompletionEvidenceGate.evaluate`, `isCompletionEvidenceGateEnabled` sibling flag | C5 |
| `src/llm/prompt-sections-trim.test.ts` | verify/implement assertions | wording pins |
| `src/agent/request-analysis.test.ts` | `resolveVerifyPlaybookPrompt` cases | C3 |
| `src/agent/policy-guidance-regression.test.ts` | phase guidance cases | C1/C2 |
| `src/agent/completion-evidence.fail-to-pass.test.ts` | new | C5 |
| `src/eval/prompt-wording-ab-benchmark.ts` | `SCENARIOS`, section map | C6 |

---

## 11. Implementation Context

```yaml
implementation_context:
  task_summary: >-
    Upgrade LLM behaviour in IMPLEMENT and VERIFY: reproduction-before-fix,
    smallest coherent mutation, no test weakening, inline falsifying checks;
    fresh/mapped/honest verification, diff audit, fail-to-pass for bugfix,
    independent falsification; one aligned completion-gate rule; A/B validation.
  acceptance_criteria:
    - "IMPLEMENT guidance states: reproduce before editing (bugfix/security); smallest coherent change with canonical tools (replace_text, write_file); never weaken tests; run the cheapest falsifying check via run_command after each mutation batch."
    - "VERIFY guidance states: fresh evidence after the last edit; claim→run_command+scope+outcome mapping; honest unverified reporting; diff audit; fail→pass for bugfix/security; independent falsification when available."
    - "Guidance and playbook references stay 100% harmonized with the 4 core canonical tools (run_command, read_file, replace_text, write_file) without assuming deprecated standalone tools."
    - "resolveVerifyPlaybookPrompt is monotonic in risk: R3+ is at least as strong as R2."
    - "CompletionEvidenceGate blocks a bugfix/security completion that skipped a pre-fix failure observation, unless exempted or the kill-switch is off."
    - "All wording and gate tests updated in the same step; build + targeted suites pass."
    - "A/B benchmark reports old-vs-new pass rates for the two new scenarios."

  evidence_provenance:  # exact schema-2 output of evidence-provenance.mjs snapshot
    schema_version: 2
    head_commit: "35979bc81eb7efa2eb1e96abeed7936473296940"
    generated_plan_path: "docs/plans/2026-11-06-gitnexus-plan-llm-implement-verify-phase-behavior.md"
    global_dirty_digest:
      algorithm: "sha256"
      canonicalization: "gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records"
      value: "0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd"
    cited_path_manifest:
      - path: "package.json"
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: "sha256:7b51141fd7335753bfd344644e054655755a91ec34227cbddf237b219881d6da"
        index_digest: "sha256:7b51141fd7335753bfd344644e054655755a91ec34227cbddf237b219881d6da"
        worktree_digest: "sha256:7b51141fd7335753bfd344644e054655755a91ec34227cbddf237b219881d6da"
        untracked_digest: "absent"
      - path: "src/agent/agent-loop.ts"
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: "sha256:55efe18fa75c5dfb42d317923f7676f3679e2b72f1fab5de3ba1fbd944126c02"
        index_digest: "sha256:55efe18fa75c5dfb42d317923f7676f3679e2b72f1fab5de3ba1fbd944126c02"
        worktree_digest: "sha256:fb71f3a56ce2b250bc8d51ff0f105df0f71933c9bead8cece089cb466c7d0813"
        untracked_digest: "absent"
      - path: "src/agent/completion-evidence.ts"
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: "sha256:5ef063b416ca78032057de96368e03634dfd93668dd371376df460d8ccc05691"
        index_digest: "sha256:5ef063b416ca78032057de96368e03634dfd93668dd371376df460d8ccc05691"
        worktree_digest: "sha256:5a57500d619887047df79d9eb1df2e22f63742aa2472f6a454ac52d6e8af19b2"
        untracked_digest: "absent"
      - path: "src/agent/dynamic-context-arbiter.ts"
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: "sha256:326fe220630f8f4ee010df70e3fc48900e89357983561c793bd8a24f19621c1e"
        index_digest: "sha256:326fe220630f8f4ee010df70e3fc48900e89357983561c793bd8a24f19621c1e"
        worktree_digest: "sha256:32424725a37bc3b9e7818933f1bf425f6d5b1b860e0ecef2b0b831b910ab4c34"
        untracked_digest: "absent"
      - path: "src/agent/phase-lifecycle.ts"
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: "sha256:30ebd2f44befa3df27eb137c73b23fca9aa70ceb79f2cbcecac6ed37e2ec29e2"
        index_digest: "sha256:30ebd2f44befa3df27eb137c73b23fca9aa70ceb79f2cbcecac6ed37e2ec29e2"
        worktree_digest: "sha256:9ac74560004cd3a10fdee1e8110ae947f1f11722a6f10c630557aeb0e79970f0"
        untracked_digest: "absent"
      - path: "src/agent/policy-guidance-regression.test.ts"
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: "sha256:a728b11d8fbc0f64a7e48632468172e791d843f9fd702f6a3fa33f6cbfbba5d5"
        index_digest: "sha256:a728b11d8fbc0f64a7e48632468172e791d843f9fd702f6a3fa33f6cbfbba5d5"
        worktree_digest: "sha256:eaf372d8a3c0b679c3725f17b29f92b9e406a6d0aee2cebfe46f625297ca442d"
        untracked_digest: "absent"
      - path: "src/agent/prompt-engineering-patterns.test.ts"
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: "sha256:5d18d85b8e47e3ed6f346fd215532040b404fe2d2ff9ca5c03c454b6e8599c61"
        index_digest: "sha256:5d18d85b8e47e3ed6f346fd215532040b404fe2d2ff9ca5c03c454b6e8599c61"
        worktree_digest: "sha256:d62bfc074dd0c0c53ba1ed11f035fce5e68ce04bbaac0d8957ff7502d9ec8de0"
        untracked_digest: "absent"
      - path: "src/agent/request-analysis.test.ts"
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: "sha256:c9af8aeb1b7dcc8c9fc2b5a6c8754d3ded181b722ec88e5d2ed28a350d5ee6f5"
        index_digest: "sha256:c9af8aeb1b7dcc8c9fc2b5a6c8754d3ded181b722ec88e5d2ed28a350d5ee6f5"
        worktree_digest: "sha256:79e6638c119a1e31bb5ab84ca042163574af14d2c28014c6e8604b96e255cf62"
        untracked_digest: "absent"
      - path: "src/agent/step-prompt-policy.ts"
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: "sha256:dae7bb7a439057ba5734247e76118acf846177ed91df477e2a35e9362ba3f494"
        index_digest: "sha256:dae7bb7a439057ba5734247e76118acf846177ed91df477e2a35e9362ba3f494"
        worktree_digest: "sha256:bc96a91ece0a537fd67d7d4a08d62e5fc76ef86ea4fae9f51784453cb0842afc"
        untracked_digest: "absent"
      - path: "src/agent/submission-readiness.test.ts"
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: "sha256:9004d3b49928ddb5a6954a9a3d2b04c3a9691ab22862ac63d76fa20e7856480c"
        index_digest: "sha256:9004d3b49928ddb5a6954a9a3d2b04c3a9691ab22862ac63d76fa20e7856480c"
        worktree_digest: "sha256:9004d3b49928ddb5a6954a9a3d2b04c3a9691ab22862ac63d76fa20e7856480c"
        untracked_digest: "absent"
      - path: "src/eval/prompt-wording-ab-benchmark.ts"
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: "sha256:b9814408f63ed386655016f9e1827ac77bb39bd64f316dad47993713a4fe6743"
        index_digest: "sha256:b9814408f63ed386655016f9e1827ac77bb39bd64f316dad47993713a4fe6743"
        worktree_digest: "sha256:b9814408f63ed386655016f9e1827ac77bb39bd64f316dad47993713a4fe6743"
        untracked_digest: "absent"
      - path: "src/llm/prompt-sections-trim.test.ts"
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: "sha256:06cfc52ad35441ded46944e66f42be0fd8d7ee389fc7902e9d1be4b4da37eb90"
        index_digest: "sha256:06cfc52ad35441ded46944e66f42be0fd8d7ee389fc7902e9d1be4b4da37eb90"
        worktree_digest: "sha256:efee9e571e3b6aa6c64b63f9f186ac1275cf3df9ec15e6676696e9b7441edfde"
        untracked_digest: "absent"
      - path: "src/llm/prompts.ts"
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: "sha256:d887642602fab5766d6b6a0237b04dd3a6793f73c75467f10f07330513958f11"
        index_digest: "sha256:d887642602fab5766d6b6a0237b04dd3a6793f73c75467f10f07330513958f11"
        worktree_digest: "sha256:cdab066ef1c671fafc29e0bab4a48a543ca7005c988a5bf98deaf16c517ceca0"
        untracked_digest: "absent"
      - path: "src/llm/sections/phases.ts"
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: "sha256:1711c4689b794c38b8ec23f7bffbdd37c143ba6fb42032f86f3d5758448677aa"
        index_digest: "sha256:1711c4689b794c38b8ec23f7bffbdd37c143ba6fb42032f86f3d5758448677aa"
        worktree_digest: "sha256:a09ceb38f5d8ca362be086dfafeda227ae1814a94f239006ac447e6c77bd378d"
        untracked_digest: "absent"
      - path: "src/llm/sections/tools.ts"
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: "sha256:af5638dcdf35b1cbfd71846b0bf95b177e21405aa77a67f0a06e43a809dcf086"
        index_digest: "sha256:af5638dcdf35b1cbfd71846b0bf95b177e21405aa77a67f0a06e43a809dcf086"
        worktree_digest: "sha256:2646a6ed628377af7a7d16e3a9d76b1e2b67ef85dedb87284eac92afd5fa3752"
        untracked_digest: "absent"
      - path: "src/skills/verification-policy.ts"
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: "sha256:42ba76ada7d0bb332f94268327b33057dd76e6958732f1a08fda737f63bdf398"
        index_digest: "sha256:42ba76ada7d0bb332f94268327b33057dd76e6958732f1a08fda737f63bdf398"
        worktree_digest: "sha256:109e14193f02bbe87eab3dd1c18ceb46f2d169654b2acca724e61e4db29e7e6d"
        untracked_digest: "absent"

  primary_symbols:
    - { symbol: "SECTION_PHASE_IMPLEMENT_GUIDANCE", file: "src/llm/sections/phases.ts", lines: "32-39", role: "implement-phase prompt" }
    - { symbol: "SECTION_PHASE_VERIFY_GUIDANCE", file: "src/llm/sections/phases.ts", lines: "41-48", role: "verify-phase prompt" }
    - { symbol: "resolveVerifyPlaybookPrompt", file: "src/llm/sections/tools.ts", lines: "99-111", role: "risk-tiered verify steps" }
    - { symbol: "CompletionEvidenceGate.evaluate", file: "src/agent/completion-evidence.ts", lines: "265-420", role: "claim↔evidence enforcement; reproduction rule at 313" }
    - { symbol: "resolvePhaseDynamicGuidanceUncached", file: "src/llm/sections/phases.ts", lines: "87-126", role: "phase → guidance selection (pure)" }

  related_symbols:
    - { symbol: "resolvePhaseDynamicGuidance", relationship: "CALLS", relevance: "cached wrapper, called at agent-loop.ts:2368" }
    - { symbol: "formatVerificationGuidance", relationship: "CALLS", relevance: "verification tier guidance concatenated at agent-loop.ts:2612" }
    - { symbol: "recordImplementationCompleted / recordVerificationOutcome", relationship: "CALLS", relevance: "durable phase boundary at agent-loop.ts:4745" }
    - { symbol: "classifyToolEvidence", relationship: "CALLS", relevance: "returns [] for failed results — constraint for C5" }
    - { symbol: "isVerificationCommand / extractCommandString / isToolResultFailure", relationship: "CALLS", relevance: "pre-fix failure detection primitives" }
    - { symbol: "captureCommandBaseline", relationship: "CALLS", relevance: "existing pre-edit baseline; regression attribution, not repro proof" }
    - { symbol: "StepPromptPolicy.decide", relationship: "CALLS", relevance: "selects verifyDiff playbook in verify phase" }
    - { symbol: "isUserExplicitlyExemptingTests", relationship: "CALLS", relevance: "existing exemption for C5" }

  execution_path:
    - "AgentLoop.runInternal builds phase guidance from classification + evidence options (2368)."
    - "VerificationPolicy.formatVerificationGuidance appends tier requirements and freshness (2612)."
    - "DynamicContextArbiter ranks it at priority 1.5 under a token budget and truncates lower-priority blocks first."
    - "A verification command after the latest mutation records implementationCompleted and, if policy passes, verificationCompleted (4745-4756)."
    - "On completion, CompletionEvidenceGate evaluates the final answer against this turn's executions; bugfix/security reproduction is checked here."
    - "The gate is non-bypassable except by its env kill-switch; phase lifecycle remains seq-bound."

  pdg_constraints:
    - description: "Freshness is bound to latestMutationSeq, not wall-clock."
      affected_statements: ["src/agent/phase-lifecycle.ts:333", "src/agent/phase-lifecycle.ts:334", "src/agent/phase-lifecycle.ts:335"]
      implementation_consequence: "Any reproduction/freshness rule must compare execution seq against the first/latest mutation seq."
    - description: "Verify guidance branch is a pure string concat; no side effects."
      affected_statements: ["src/llm/sections/phases.ts:87", "src/llm/sections/phases.ts:91", "src/llm/sections/phases.ts:120"]
      implementation_consequence: "Guidance edits cannot corrupt lifecycle state; only budget/wording tests can break."

  architectural_patterns:
    - { pattern: "Tiered prompt sections (T0 system, T2 static cache-stable, T3 dynamic tail)", example_location: "src/llm/prompts.ts + src/agent/dynamic-context-arbiter.ts", usage_guidance: "Phase guidance is always T3; never move it into the system prompt." }
    - { pattern: "Cheap dynamic macro interpolation", example_location: "src/llm/sections/shared.ts FILE_MUTATION_SAFETY_RULE", usage_guidance: "Reuse macros instead of duplicating rules; tests assert single-sourcing." }
    - { pattern: "Default-on gate with explicit env kill-switch", example_location: "src/agent/completion-evidence.ts:213-219", usage_guidance: "Follow for the fail-to-pass rule." }
    - { pattern: "Wording A/B benchmark reading old text from git", example_location: "src/eval/prompt-wording-ab-benchmark.ts:38-71", usage_guidance: "Add scenarios rather than a second harness." }

  files_to_modify:
    - { file: "src/llm/sections/phases.ts", symbols: ["SECTION_PHASE_IMPLEMENT_GUIDANCE", "SECTION_PHASE_VERIFY_GUIDANCE", "PhaseGuidanceOptions", "resolvePhaseDynamicGuidanceUncached"], intended_change: "C1/C2/C4" }
    - { file: "src/llm/sections/tools.ts", symbols: ["resolveVerifyPlaybookPrompt", "TOOL_PLAYBOOK_PROMPTS"], intended_change: "C3 monotonic risk playbook" }
    - { file: "src/agent/agent-loop.ts", symbols: ["runInternal"], intended_change: "pass hasReproduction into phase guidance" }
    - { file: "src/agent/completion-evidence.ts", symbols: ["CompletionEvidenceGate.evaluate"], intended_change: "C5 pre-fix failure requirement + kill-switch" }
    - { file: "src/eval/prompt-wording-ab-benchmark.ts", symbols: ["SCENARIOS"], intended_change: "C6 two behavioural scenarios" }

  tests:
    - file: "src/llm/prompt-sections-trim.test.ts"
      scenarios:
        - "verify/implement guidance → contains new rules; scope phrases preserved → assertions pass"
        - "each dynamic section → length/4 ≤ 500 → pass"
    - file: "src/agent/request-analysis.test.ts"
      scenarios:
        - "resolveVerifyPlaybookPrompt(R3) → contains fail→pass + diff audit"
        - "resolveVerifyPlaybookPrompt(R1) → still contains 'verify state'"
    - file: "src/agent/policy-guidance-regression.test.ts"
      scenarios:
        - "verify guidance → fresh/mapped/honest present"
        - "implement guidance bugfix → reproduction-before-edit present"
    - file: "src/agent/completion-evidence.fail-to-pass.test.ts"
      scenarios:
        - "failing check before mutation + pass after → allowed"
        - "no pre-fix run + pass after → blocked"
        - "blocked preflight + pass after → blocked"
        - "feature task same shape → allowed"
        - "/no-verify exemption → allowed"
        - "kill-switch off → allowed"
        - "docs-only mutation → allowed"

  verification_commands:
    - "npm run build"
    - "npm run test:completion"
    - "npm run test:prompt-gating"
    - "npm test"
    - "node --import tsx src/eval/prompt-wording-ab-benchmark.ts --scenario=bugfix-reproduce --rounds=5   # manual, needs GEMINI_API_KEY"

  risks:
    - "Over-blocking bugfix completion when local reproduction is impossible — mitigated by exemptions + env kill-switch."
    - "Prompt budget: two rewrites could exceed 500 tokens/section and be truncated."
    - "Existing wording tests encode old text and will fail until updated in the same step."
    - "A/B benchmark is live-model and rate-limited; advisory only."

  assumptions:
    - "Bugfix/security is the only task class where a pre-fix failure is a reasonable hard requirement. Verify: completion-evidence.ts:314 already scopes to bugfix/security."
    - "R3+ should be strictly stronger than R2. Verify against the risk ladder in verification-policy.ts:432-442 before editing."
    - "Guiding text alone measurably changes tool behaviour; the A/B harness is the check."
    - "No cache-stable section needs to change; phase guidance stays dynamic."

  open_questions:
    - "Should a test-file weakening (deleted/skipped assertions) be a hard gate or guidance only? Deferred — heuristic risk without a robust signal."
    - "Should the fail-to-pass rule apply to feature tasks whose change adds a failing-case test? Current plan: no."
    - "Is a second-model red-team review available in this harness at verify time, or only as a manual user step?"

  avoid:
    - "Do not move phase guidance into the system prompt or a cache-stable tier."
    - "Do not add a new tool, phase, event type, or subsystem."
    - "Do not duplicate formatVerificationGuidance freshness text in phase prose."
    - "Do not derive reproduction from LLM-declared claims; use executions/seq only."
    - "Do not modify tests to make the new prose pass without asserting the new behaviour."
    - "Do not gate CI on the live A/B benchmark."
```

---

## 12. Assumptions and Open Questions

**Assumptions**
- [assumed] Bugfix/security is the right and only scope for a hard fail→pass requirement — `completion-evidence.ts:314` already scopes reproduction to that class.
- [assumed] R3+ should be strictly stronger than R2; the risk ladder in `verification-policy.ts:432-442` is the source of truth to re-read before editing.
- [assumed] The A/B harness is an acceptable proxy for "better behaviour"; scenario scoring is call-based, not prose-based.
- [verified] The working tree was clean at snapshot time, so every citation matches HEAD `35979bc`.
- [verified] `evidence-provenance.mjs snapshot` succeeded (schema 2), but its `write-plan` command refuses win32 by design. The plan was therefore written with a plain file write; the recorded digest and manifest are the helper's real output, not a reconstruction.
- [verified] Cited `worktree_digest` values differ from `head_digest` on most files because the Windows checkout stores CRLF while the Git blob stores LF; `state: clean` is still correct per Git. Do not read that difference as uncommitted work.

**Open questions**
- Test-integrity enforcement (detect weakened assertions) — deferred; needs a reliable signal, not a keyword heuristic.
- Whether feature tasks should also require fail→pass when their own new test is the failing case.
- Whether an independent reviewer is available to the agent at verify time, or whether that sentence only describes a user-side step.

**Deferred (not in scope)**
- An `implementCheck` per-step playbook in `StepPromptPolicy` (guidance text covers it; adding a playbook would touch 11 callers for marginal gain).
- Localizing the new guidance (repo guidance is English; final answers already localize).
- Adding a mutation-testing step to verify.

---

## 13. Definition of Done

1. `SECTION_PHASE_IMPLEMENT_GUIDANCE` contains: reproduction-before-edit (bugfix/security), smallest-coherent-change, never-weaken-tests, cheapest-falsifying-check-after-mutation.
2. `SECTION_PHASE_VERIFY_GUIDANCE` contains: fresh, mapped, honest, diff audit, fail→pass (bugfix/security), independent falsification — while keeping the asserted scope sentences.
3. `resolveVerifyPlaybookPrompt` is monotonic: R3+ ≥ R2 in required evidence.
4. `CompletionEvidenceGate` blocks a bugfix/security completion with no pre-fix failure observation; exemptions and `MINUS_FAIL_TO_PASS_GATE=off` still allow it.
5. `npm run build` exits 0.
6. `npm run test:completion`, `npm run test:prompt-gating`, and `npm test` pass with updated wording assertions.
7. The A/B benchmark reports old-vs-new pass rates for `bugfix-reproduce` and `verify-freshness`, with the new variant not worse on either.
8. Every dynamic section stays ≤500 tokens (~1250 chars at the repo's 4 chars/token estimate).
