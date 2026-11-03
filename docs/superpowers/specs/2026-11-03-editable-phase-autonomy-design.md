# Editable Phase Autonomy Design

## Intent

Allow an editable task to mutate while its inferred classification phase is `explore` or `plan`. Preserve explicit user authorization boundaries and every unrelated safety guard.

## Goals

- Inferred `explore`/`plan` phases do not block mutation by themselves.
- Literal read-only and planning directives still block state-changing effects.
- Plan lock and permission mode `read_only` still deny mutations.
- Workspace, sandbox, approval, protected-file, Git, redaction, and hook policies remain unchanged.

## Non-goals

- No evidence-gate, cognitive-prompt, orchestration, or tool-catalog cleanup.
- No commit or push.
- No rewrite or revert of existing uncommitted work.

## Approach

Keep `checkPhaseToolEffect` as the strict effect evaluator. Build on the existing `AgentLoop` phase-mask opening for editable tasks, and change `ToolRunner.run` so classifier phase alone no longer invokes that evaluator. Invoke it for literal read-only/`/plan` directives regardless of the phase-mask gate; leave plan lock and permission `read_only` enforcement in `PermissionManager`.

The alternative of deleting `checkPhaseToolEffect` was rejected because read-only authorization still needs its argument-dependent shell and Git checks. Broadly opening every permission gate was also rejected because it would weaken unrelated safety policy.

## Verification

Focused tests must prove editable inferred phases execute mutations in `off`, `shadow`, and `enforce` control modes, while explicit read-only, `/plan`, plan lock, and `read_only` still prevent execution. Run runner/security regressions and TypeScript checking, separating any pre-existing baseline failures.
