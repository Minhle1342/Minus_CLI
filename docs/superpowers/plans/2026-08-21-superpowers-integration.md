# Superpowers Integration Implementation Plan

> **For agentic workers:** Implement this plan phase-by-phase. Preserve the existing session, memory, tool-scope, effect-ledger, and subagent invariants. Run the focused test for each phase before the full suite.

**Goal:** Integrate the skills and methodology from `obra/superpowers` into this coding assistant so skills are discovered and activated automatically, while every skill action is mapped to an explicit, policy-checked capability.

**Architecture:** Markdown skill files remain instructions, not LLM tools. A `SkillRegistry` discovers and validates skill metadata, a `SkillActivator` selects applicable skills and injects their content through the existing `PromptAssembler`, and a `CapabilityCatalog` maps the operations named by skills to `ToolRegistry` providers, approval policy, side-effect metadata, and retry semantics. Session events record skill activation and capability decisions so restart/replay remains auditable.

**Tech Stack:** TypeScript, Node.js ESM, existing `AgentLoop`, `AgentHookRegistry`, `PromptAssembler`, `ToolRegistry`/`ToolScope`, `Session`/`SessionPersistence`, `SessionManager`, `EffectLedger`, `AgentRegistry`, and the existing `npm test` / `npm run build` commands.

**Spec:**

- [obra/superpowers README](https://github.com/obra/superpowers/blob/main/README.md)
- [using-superpowers/SKILL.md](https://github.com/obra/superpowers/blob/main/skills/using-superpowers/SKILL.md)
- [subagent-driven-development/SKILL.md](https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/SKILL.md)
- [Codex tool reference](https://github.com/obra/superpowers/blob/main/skills/using-superpowers/references/codex-tools.md)

## Global Constraints

- Do not expose skill Markdown as a function declaration; only capability adapters belong in the LLM tool catalog.
- Do not bypass `ToolRunner`, `ToolScope`, workspace safety, approval policy, or `EffectLedger` for skill actions.
- A skill may request a capability, but policy decides whether that capability is available, requires approval, or is denied.
- Preserve append-only session history and stable tool-call/effect IDs.
- Skill activation must be deterministic for the same session state, user request, catalog version, and skill set.
- Skill files are untrusted input until validated; reject path traversal, malformed front matter, duplicate IDs, and unsupported versions.
- Existing dirty worktree changes belong to the user. Do not reset, checkout, stage, or commit unrelated files.
- Full Superpowers subagent workflows require explicit child lifecycle, clean context, model selection, review, and wait semantics; the existing background delegation API is not sufficient by itself.
- No vector database is required for this integration. Skill content is local, versioned instruction data; project/session memory remains a separate subsystem.

## Current Capability Baseline

Already available and reusable:

- `PromptAssembler`: deterministic plugin-extensible system prompt sections.
- `AgentHookRegistry`: turn, step, request, and stopping lifecycle hooks.
- `ToolRegistry`/`ToolScope`/`ToolRunner`: function declarations, allowlists, validation, workspace safety, and normalized errors.
- `Session`/`SessionPersistence`/`SessionManager`: event-sourced history, JSONL persistence, fork, diagnostics, and crash recovery.
- `PlanManager`, `GoalManager`, `AgentRegistry`, `SubagentManager`, and `EffectLedger`.
- Core file/search/edit/command tools, memory tools, planning tools, and child-agent tools.

Important gaps to close:

- No skill catalog, loader, compatibility metadata, or automatic activation protocol.
- No capability catalog that describes approval, side effects, reversibility, retryability, and availability separately from tool schemas.
- No dedicated worktree lifecycle tools; `run_command` is intentionally too restricted for the full git-worktree workflow.
- No clean-context `spawn_agent` contract with explicit model/reasoning selection, `wait_agent`, task-review lifecycle, and bounded child ownership.
- No model-facing approval/question capability for human checkpoints.

---

## Phase 0: Freeze Contracts and Baseline

### Task 0.1: Record the baseline

**Files:**

- Read: `package.json`, `src/agent/agent-loop.ts`, `src/tools/registry.ts`, `src/session/session.ts`, `src/kernel/kernel.ts`, `src/test-suite.ts`.
- Modify: `docs/superpowers/plans/2026-08-21-superpowers-integration.md` only if a baseline assumption changes.

**Steps:**

- [ ] Run `npm run build` and record the result.
- [ ] Run `npm test` and record the passing assertion count.
- [ ] Run `git status --short` and preserve the existing dirty-file list.
- [ ] Confirm the current default tool names and existing session event types before adding new contracts.

**Acceptance:** The plan executor has a clean build/test baseline and an explicit list of pre-existing changes.

### Task 0.2: Define the integration vocabulary

**Files:**

- Create: `src/skills/types.ts`.
- Create: `src/capabilities/types.ts`.
- Test: `src/test-suite.ts`.

**Interfaces:**

```ts
export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  source: 'builtin' | 'workspace' | 'external';
  path: string;
  requires?: string[];
  conflicts?: string[];
  priority?: number;
  autoActivate?: boolean;
}

export interface CapabilityDescriptor {
  name: string;
  toolName?: string;
  category: 'filesystem' | 'shell' | 'git' | 'worktree' | 'agent' | 'approval' | 'planning' | 'memory';
  sideEffect: 'none' | 'workspace' | 'external';
  reversible: boolean;
  requiresApproval: boolean;
  retryable: boolean;
  description: string;
}
```

**Acceptance:** Invalid IDs, blank descriptions, unsupported side-effect values, and duplicate capability names are rejected by unit tests.

## Phase 1: Skill Catalog and Loader

### Task 1.1: Implement safe skill discovery

**Files:**

- Create: `src/skills/skill-registry.ts`.
- Create: `src/skills/skill-loader.ts`.
- Modify: `src/kernel/kernel.ts`.
- Test: `src/test-suite.ts`.

**Requirements:**

- Discover skills from a configured root such as `.codingagent/skills/` and an explicitly registered external root.
- Parse YAML-like front matter without executing skill content.
- Validate `name`, `description`, unique `id`, supported version, and resolved path containment.
- Expose `register`, `unregister`, `get`, `list`, `findApplicable`, and `loadContent`.
- Return structured diagnostics for malformed or unavailable skills rather than silently activating them.
- Do not load every skill into every prompt; load only selected skills.

**Acceptance:** A fixture directory containing valid, duplicate, malformed, and path-traversal skill files produces deterministic registry results and safe errors.

### Task 1.2: Import the Superpowers skill set as a versioned source

**Files:**

- Create: `src/skills/superpowers-source.ts`.
- Modify: `.gitignore` only if a local cache directory is introduced.
- Test: `src/test-suite.ts`.

**Requirements:**

- Support a local checkout path and a pinned remote/reference metadata record.
- Register only the intended `skills/*/SKILL.md` files, not arbitrary repository files.
- Record repository revision or content hash in the manifest.
- Keep updating external content separate from runtime activation.

**Acceptance:** The loader can register `using-superpowers`, `brainstorming`, `writing-plans`, `test-driven-development`, `using-git-worktrees`, `subagent-driven-development`, `requesting-code-review`, and `finishing-a-development-branch` from a pinned local source.

## Phase 2: Skill Activation and Prompt Integration

### Task 2.1: Implement deterministic activation policy

**Files:**

- Create: `src/skills/skill-activator.ts`.
- Modify: `src/llm/prompt-assembler.ts`.
- Modify: `src/agent/agent-hooks.ts`.
- Modify: `src/agent/agent-loop.ts`.
- Test: `src/test-suite.ts`.

**Requirements:**

- Evaluate the user request, current phase, goal/plan state, and available capabilities.
- Apply priority, `requires`, and `conflicts` deterministically.
- Always make `using-superpowers`-style bootstrap behavior explicit for configured sessions.
- Inject activated skill content as named prompt sections, not by rewriting arbitrary history.
- Re-apply the bootstrap after context compaction if the active skill set is still valid.
- Emit activation decisions for observability.

**Acceptance:** The same input/session/catalog produces the same ordered skill IDs and assembled prompt; conflicting skills produce a recorded denial/reason.

### Task 2.2: Persist skill lifecycle decisions

**Files:**

- Modify: `src/session/session.ts`.
- Modify: `src/session/session-persistence.ts`.
- Modify: `src/session/session-manager.ts`.
- Test: `src/test-suite.ts`.

**Requirements:**

- Add a typed `skill/change` or `skill/activation` event containing skill ID, version/hash, decision, reason, and timestamp.
- Reconstruct the active skill projection from the event log.
- On restart, validate the recorded hash/version and mark stale skills unavailable rather than silently using changed content.

**Acceptance:** Save/load/replay preserves activation decisions and detects a changed skill source.

## Phase 3: Capability and Tool Catalog

### Task 3.1: Implement the capability catalog

**Files:**

- Create: `src/capabilities/capability-catalog.ts`.
- Create: `src/capabilities/capability-policy.ts`.
- Modify: `src/tools/registry.ts`.
- Modify: `src/tools/tool-runner.ts`.
- Modify: `src/kernel/kernel.ts`.
- Test: `src/test-suite.ts`.

**Requirements:**

- Register descriptors separately from function declarations.
- Map a capability to a concrete tool only when the tool is installed and in scope.
- Expose catalog queries to the activator and diagnostics, but expose only allowed function declarations to the model.
- Enforce `requiresApproval`, `sideEffect`, `reversible`, and `retryable` at execution time.
- Return actionable denial errors such as `CAPABILITY_UNAVAILABLE`, `APPROVAL_REQUIRED`, and `CAPABILITY_OUT_OF_SCOPE`.

**Acceptance:** A skill cannot invoke an undeclared capability, a read-only scope cannot receive write capabilities, and all denials are durable and testable.

### Task 3.2: Register the baseline mappings

**Files:**

- Create: `src/capabilities/default-capabilities.ts`.
- Modify: `src/tools/registry.ts`.
- Test: `src/test-suite.ts`.

**Mappings:**

| Capability | Existing adapter | Policy |
|---|---|---|
| `filesystem.read` | `read_file` | no approval, no side effect |
| `filesystem.list` | `list_files` | no approval, no side effect |
| `filesystem.search` | `search_text` | no approval, no side effect |
| `filesystem.edit` | `replace_text` | workspace side effect, effect ledger |
| `filesystem.write` | `write_file` | workspace side effect, effect ledger |
| `shell.verify` | `run_command` | allowlist/sandbox policy |
| `plan.update` | planning tools | session state mutation |
| `memory.retrieve` | memory tools | no workspace side effect |
| `agent.delegate` | `delegate_agent` | child-agent policy |

**Acceptance:** Every baseline skill can resolve its declared capability names before execution, and no capability silently falls back to arbitrary `run_command`.

## Phase 4: Worktree, Git, Approval, and Verification Adapters

### Task 4.1: Add controlled worktree capability

**Files:**

- Create: `src/tools/worktree-tools.ts`.
- Create: `src/workspace/worktree-manager.ts`.
- Modify: `src/kernel/kernel.ts`.
- Modify: `src/capabilities/default-capabilities.ts`.
- Test: `src/test-suite.ts`.

**Requirements:**

- Provide create/list/remove/status operations with path containment and branch validation.
- Use an ignored project-local worktree root.
- Refuse deletion of the active worktree or an unverified path.
- Record worktree operations as effect-ledger/session events.

**Acceptance:** A temporary test repository can create and inspect an isolated worktree, while unsafe paths and active-worktree deletion are rejected.

### Task 4.2: Add policy-controlled Git operations

**Files:**

- Create: `src/tools/git-tools.ts`.
- Modify: `src/capabilities/default-capabilities.ts`.
- Modify: `src/tools/run-command.ts` only for shared validation helpers, not by widening arbitrary shell access.
- Test: `src/test-suite.ts`.

**Requirements:**

- Expose status/diff/log/read operations without approval.
- Expose add/commit/branch/merge/PR preparation only behind explicit approval policy.
- Never allow skill content to construct unrestricted shell commands for Git.

**Acceptance:** Read-only Git capabilities work in a fixture repository; mutating Git capabilities return `APPROVAL_REQUIRED` until approved.

### Task 4.3: Add human approval/question capability

**Files:**

- Create: `src/tools/approval-tools.ts`.
- Create: `src/agent/approval-manager.ts`.
- Modify: `src/agent/agent-inbox.ts`.
- Modify: `src/session/session.ts`.
- Test: `src/test-suite.ts`.

**Requirements:**

- Support `ask_user`/approval requests with stable IDs, timeout/cancel, and durable pending state.
- Block the relevant tool/effect until approval is resolved.
- Resolve approval through CLI and a programmatic API.
- Never treat process restart as approval.

**Acceptance:** A write, commit, or merge request pauses with a durable approval record and resumes only after explicit approval.

### Task 4.4: Add verification capability contract

**Files:**

- Create: `src/skills/verification-policy.ts`.
- Modify: `src/agent/agent-loop.ts`.
- Modify: `src/agent/effect-ledger.ts`.
- Test: `src/test-suite.ts`.

**Requirements:**

- Require a verification capability after edits when the active skill mandates it.
- Record command, exit code, relevant output digest, and verification result in session state.
- Prevent a final answer that claims completion when required verification failed or was skipped.

**Acceptance:** `verification-before-completion` behavior is enforced by policy, not only by prompt text.

## Phase 5: Superpowers-Compatible Subagent Orchestration

### Task 5.1: Extend child-agent lifecycle

**Files:**

- Modify: `src/agent/subagent-manager.ts`.
- Modify: `src/tools/subagent-tools.ts`.
- Modify: `src/agent/agent-registry.ts`.
- Modify: `src/session/session.ts`.
- Test: `src/test-suite.ts`.

**Requirements:**

- Add explicit `spawn_agent`, `get_agent_result`, `wait_agent`, `stop_agent`, and `resume_agent` semantics.
- Support clean child context (`fork_turns: none` equivalent), explicit model/reasoning options, tool scope, and worktree/session binding.
- Persist parent/child relationship, task brief, status, and review state.
- Prevent a child from recursively spawning a child unless policy explicitly permits it.

**Acceptance:** A child receives only its task brief and declared interfaces, can be awaited without polling loops, and its lifecycle is recoverable after restart.

### Task 5.2: Implement task-review gates

**Files:**

- Create: `src/agent/review-manager.ts`.
- Create: `src/tools/review-tools.ts`.
- Modify: `src/agent/plan-manager.ts`.
- Modify: `src/session/session.ts`.
- Test: `src/test-suite.ts`.

**Requirements:**

- Model implementer/reviewer roles separately.
- Require spec-compliance and quality verdicts before marking a task complete.
- Persist findings, fix rounds, rulings, and reviewer evidence.
- Cap fix rounds and expose unresolved findings instead of looping indefinitely.

**Acceptance:** A task cannot transition to completed without both review verdicts or an explicit operator ruling.

## Phase 6: Skill Workflow Integration

### Task 6.1: Map the core Superpowers workflow

**Files:**

- Create: `src/skills/workflow-map.ts`.
- Modify: `src/agent/goal-manager.ts`.
- Modify: `src/agent/plan-manager.ts`.
- Modify: `src/agent/agent-loop.ts`.
- Test: `src/test-suite.ts`.

**Workflow:**

```text
brainstorming
→ approved design
→ isolated worktree
→ writing-plans
→ TDD / implementation
→ task review
→ verification-before-completion
→ finishing-development-branch
```

**Acceptance:** The workflow map prevents implementation skills from activating before the required design/plan/approval state and records every transition.

### Task 6.2: Re-inject skills after compaction and restart

**Files:**

- Modify: `src/agent/context-compactor.ts`.
- Modify: `src/agent/agent-loop.ts`.
- Modify: `src/skills/skill-activator.ts`.
- Test: `src/test-suite.ts`.

**Acceptance:** After compaction or process restart, the active skill set is reconstructed from session state and reassembled before the next model request, with stale/missing skills reported explicitly.

## Phase 7: CLI, Documentation, and Rollout

### Task 7.1: Add operator diagnostics

**Files:**

- Modify: `src/index.ts`.
- Modify: `src/ui/cli-ui.ts`.
- Test: `src/test-suite.ts`.

**Commands:**

- `/skills` — list installed, active, unavailable, and conflicting skills.
- `/skills inspect <id>` — show manifest, source hash, requirements, and capabilities.
- `/skills enable <id>` / `/skills disable <id>` — explicit session policy overrides.
- `/capabilities` — show available/denied/approval-required capabilities.
- `/approvals` — inspect and resolve pending approvals.

**Acceptance:** Every automatic decision can be explained from CLI diagnostics without reading raw JSONL.

### Task 7.2: Document installation and trust policy

**Files:**

- Modify: `README.md`.
- Create: `docs/SUPERPOWERS_INTEGRATION.md`.
- Create: `docs/superpowers/compatibility-matrix.md`.

**Acceptance:** Documentation distinguishes skill instructions from executable tools, lists supported Superpowers skills, records unsupported workflows, explains approval boundaries, and gives reproducible install/update commands.

### Task 7.3: Final verification and rollout gate

**Files:**

- Test: `src/test-suite.ts`.
- Test fixture: `tests/fixtures/superpowers/`.

**Commands:**

```text
npm run build
npm test
```

**Required integration scenarios:**

- Skill discovery and malformed-skill rejection.
- Automatic activation and conflict resolution.
- Skill-to-capability mapping and scope denial.
- Worktree create/status/remove safety.
- Approval pause/resume across restart.
- Clean-context subagent dispatch, wait, review, and recovery.
- TDD/verification gate before final completion.
- Context compaction and skill re-injection.

**Acceptance:** All existing assertions remain green; every required scenario has a behavior-level assertion; no skill can cause an unapproved side effect or bypass the capability catalog.

## Non-Goals

- Do not copy the entire Superpowers repository into runtime dependencies.
- Do not turn every Markdown section into an LLM function tool.
- Do not add a vector database solely for skill loading.
- Do not widen `run_command` into unrestricted host shell execution.
- Do not claim full compatibility until worktree, approval, subagent review, and verification gates pass integration tests.

## Definition of Done

- Skill manifests are discoverable, validated, versioned, and safely loaded.
- Relevant skills activate deterministically and survive compaction/restart.
- Every skill-requested operation resolves through a named, scoped, policy-checked capability.
- Side effects, approvals, worktrees, subagents, reviews, and verification are durable and recoverable.
- CLI diagnostics explain skill/capability decisions.
- `npm run build` passes and the complete integration suite passes with zero failures.
