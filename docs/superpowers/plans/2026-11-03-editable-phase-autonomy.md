# Editable Phase Autonomy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let editable tasks mutate during inferred `explore`/`plan` phases without weakening explicit read-only or other safety authorization.

**Architecture:** Preserve the strict phase-effect evaluator for explicit read-only scopes. Remove classifier phase as an independent runtime denial reason in `ToolRunner`, building on the existing editable-phase tool-surface opening in `AgentLoop`.

**Tech Stack:** TypeScript, Node.js test runner, tsx, GitNexus.

**Spec:** `docs/superpowers/specs/2026-11-03-editable-phase-autonomy-design.md`

## Global Constraints

- Make the smallest change that satisfies the approved scope.
- Do not overwrite or revert pre-existing uncommitted changes.
- Do not change evidence gates or unrelated safety guards.
- Do not commit or push.

## Review Focus

- Explicit `/plan` with an `implement` classification must still deny mutation; pin it in the runner contract test.
- Full-access phase-mask opening must not bypass a literal read-only request; pin it in the runner contract test.
- Plan lock must continue to outrank permissive modes; pin it with `PermissionManager.setPlanLock(true)`.
- Read-only shell inspection must remain available while shell mutation is denied; retain existing assertions.
- Control mode `off` must not become the mechanism that enables mutation; test all three modes identically.

---

### Task 1: Pin the new runner contract

**Files:**
- Modify: `src/control/policy-authority.regression.test.ts`

**Interfaces:**
- Consumes: `ToolRunner.run`, `PermissionManager.setPlanLock`, `isReadOnlyRequest`, `hasExplicitPlanningDirective`.
- Produces: Regression coverage for editable inferred phases and explicit read-only scopes.

- [ ] **Step 1: Write the failing tests**

Replace the old classifier-phase mutation denial assertions with assertions that `node write.js` executes for inferred `explore` and `plan` in every control mode. Add explicit read-only and `/plan` mutation denials, including a full-access phase-mask case and a plan-lock case; assert mutation executors were not called.

- [ ] **Step 2: Run the tests to verify the intended failure**

Run: `node --import tsx --test src/control/policy-authority.regression.test.ts`

Expected: editable inferred-phase cases fail with `PHASE_TOOL_EFFECT_BLOCKED`; existing read-only and plan-lock controls remain green.

### Task 2: Separate inferred phase from explicit read-only scope

**Files:**
- Modify: `src/tools/tool-runner.ts`

**Interfaces:**
- Consumes: `isReadOnlyRequest(request)` and `hasExplicitPlanningDirective(request)` from `src/control/request-intent.ts`.
- Produces: Runtime phase authority that only invokes `checkPhaseToolEffect` for explicit read-only/planning request scope.

- [ ] **Step 1: Implement the minimal runtime change**

Compute explicit read-only scope from the sanitized user request using both directive helpers. Call `checkPhaseToolEffect` only for that scope, independent of `phase_masking`; remove the now-unused full-access gate import and classifier-phase condition.

- [ ] **Step 2: Run focused tests**

Run: `node --import tsx --test src/control/policy-authority.regression.test.ts src/tools/tool-runner.test.ts src/security/permission-manager-project.test.ts src/security/full-access-gates.test.ts src/security/full-access-mode.regression.test.ts`

Expected: PASS.

### Task 3: Verify the bounded change

**Files:**
- Verify only; no planned product changes.

**Interfaces:**
- Consumes: Tasks 1–2.

- [ ] **Step 1: Run TypeScript verification**

Run: `npm run build`

Expected: PASS, or report only failures independently confirmed as pre-existing.

- [ ] **Step 2: Inspect the final diff and graph impact**

Run: `git diff -- src/tools/tool-runner.ts src/control/policy-authority.regression.test.ts` and GitNexus `detect_changes({scope: "all"})`.

Expected: only the intended runner/test changes are attributable to this task; pre-existing working-tree changes remain intact. Do not commit.
