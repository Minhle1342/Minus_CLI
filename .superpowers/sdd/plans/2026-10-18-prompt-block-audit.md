# Plan: Audit prompt blocks in harness for permanent removal

## Goal
Identify which system prompt blocks in the Minus CLI harness can be permanently removed without breaking agent behavior, safety, or KV-cache prefix invariance.

## Context
The harness assembles system prompts from modular sections in `src/llm/prompt-sections.ts` and `src/llm/prompts.ts`. Each section has an id, content, priority, tier, and optional condition. Some sections are always included (T0 core), some are conditionally included based on `PromptAssemblyContext`, and some are full-length variants injected for subagents.

Task: For each prompt block, analyze whether it can be permanently removed. A block is removable only if:
- Its behavior is fully duplicated by another section, OR
- Its condition never evaluates to true in production, OR
- Its content is purely informational and never acted upon by the model, OR
- The tools it describes are already removed/unregistered from the tool registry.

## Global Constraints
- KV-cache prefix invariance: T0/T1 sections must remain stable prefix; removal must not change ordering of remaining T0/T1 sections.
- Safety invariants (L1): any section encoding safety guardrails must not be removed unless equivalent guard exists elsewhere.
- KV-cache hit rate: removing a section must not reduce the cache hit rate below current baseline.
- Do not remove sections that are the sole source of a tool's usage instructions if that tool is still registered.

## Tasks
Task 1: Audit CORE_SYSTEM_PROMPT (core, T0, priority -1000) — always included, never conditional.
Task 2: Audit SECTION_GIT_OPERATIONS (git-operations, T1, priority 100) — conditional on hasGitTools.
Task 3: Audit SECTION_FRONTEND_UI (frontend-ui, T1, priority 200) — conditional on isFrontend.
Task 4: Audit SECTION_ANTIGRAVITY_TOOLS (antigravity-tools, T1, priority 300) — conditional on hasAntigravityTools.
Task 5: Audit SECTION_CODEBASE_INTELLIGENCE (codebase-intelligence, T1, priority 400) — conditional on hasCodebaseTools.
Task 6: Audit SECTION_TOOL_PLAYBOOKS (tool-playbooks, T2, priority 500) — conditional on includeStaticToolPlaybooks.
Task 7: Audit SECTION_TASK_ORCHESTRATOR_BOUNDARIES (task-orchestrator-boundaries, T2, priority 550) — conditional on hasSubagentTools.
Task 8: Audit SECTION_COMPUTER_USE (computer-use, T2, priority 600) — conditional on hasComputerTool.
Task 9: Audit SECTION_UNITY_GAME_DEV (unity-game-dev, T2, priority 700) — conditional on isUnity.
Task 10: Audit SECTION_ARCHITECTURE_ANALYSIS (architecture-analysis, T3, priority 1000) — conditional on isArchitectureAnalysis.
Task 11: Audit SECTION_TABULAR_OUTPUT (tabular-output, T3, priority 1010) — conditional on needsTabularOutput.
Task 12: Audit full-length subagent variants (SECTION_*_FULL) — injected via resolveSubagentPromptSections.
Task 13: Audit SYSTEM_PROMPT_ECHO_MARKERS (final-answer-guard.ts) — system marker strips, not prompt sections but related.
Task 14: Cross-block dependency & conflict scan — verify no two blocks duplicate or contradict each other.
Task 15: Final recommendation — which blocks to remove, which to keep, which to deprecate.
