# GitNexus Engineering Plan

> Task: Prune Dead Architectural Blocks across Minus CLI (Ink TUI, Shadow Control Plane, Computer Use Controller, Disconnected MCP Managers, and Unused Substrate Factory)
> Evidence verified at commit a47f8916ca80c5b818da2f8ef80f10cc600797de; GitNexus index fresh.
> Platform: win32 (safe write descriptor anchoring fallback applied).

## 1. Objective

Systematically prune and decommission 5 dead architectural subsystems across Minus CLI that were superseded or left unwired from the production agent loop:
1. **Deprecated React/Ink TUI (`src/ui/ink/`)**: Fully superseded by OpenCode The Elm Architecture (TEA) in `src/ui/tea/`. Pruning removes React, Ink, and ~2,300 lines of obsolete VDOM code.
2. **Shadow Control-Plane (`src/control-plane/`)**: An unintegrated 4,076-line parallel subsystem (critic, hypothesis graph, evidence ledger, state machine) never wired into `AgentLoop` or `AgentKernel`.
3. **Computer-Use Subsystem (`src/computer/`)**: 892 lines of desktop driver, computer controller, and tool stubs never registered in `ToolRegistry`.
4. **Disconnected MCP Managers (`src/mcp/`)**: `McpManager` and `ReaMcpManager` (617 lines) whose tools were explicitly disabled as no-ops in `ToolRegistry`.
5. **Single-Product Substrate Factory (`src/execution/substrate-factory.ts`)**: 34 lines of unused wrapper factory.
6. **Ad-Hoc Root Scratch Scripts (`src/test-*.ts`)**: Unreferenced scratch runners not part of `npm test`.

---

## 2. Current Behaviour

[verified] In the current codebase:
1. **TUI Subsystem**: The production interactive CLI and headless runner use `src/ui/tea/index.ts` exclusively (`src/index.ts:6`). `src/ui/ink/` remains in the tree as a deprecated fixture, pulling in `ink`, `react`, and `@types/react`. Note: `src/ui/input-line-editor.ts` is imported by `src/ui/tea/models/composer-model.ts` and must be retained.
2. **Control-Plane**: `src/control-plane/` contains an entire event-driven state machine, hypothesis falsification engine, and verification planner. However, neither `AgentLoop`, `AgentKernel`, nor `index.ts` imports any symbol from `src/control-plane/`. Only 3 test files (`completion-policy.test.ts`, `policy-consistency.test.ts`, `policy-guidance-regression.test.ts`) reference isolated classes.
3. **Computer-Use**: `src/computer/` exports `ComputerController` and `computerTool`. `src/tools/registry.ts:160` holds a stub `getComputerController()` returning `this.computerController` which is never instantiated or called.
4. **MCP Infrastructure**: `src/kernel/kernel.ts:267-269` instantiates `McpManager` and `ReaMcpManager`, passing them to `tools.attachBrowserManager()` and `tools.attachReaManager()`. In `src/tools/registry.ts:151-158`, both methods are explicit no-ops (`// No-op: browser MCP tools removed`, `// No-op: REA tools removed`).

---

## 3. Relevant Architecture

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        MINUS CLI CORE ARCHITECTURE                     │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│   CLI Entry Point (src/index.ts)                                       │
│       │                                                                │
│       ▼                                                                │
│   AgentKernel (src/kernel/kernel.ts)                                   │
│       │                                                                │
│       ├──► ToolRegistry (src/tools/registry.ts)                        │
│       │        (Core tools: run_command, read_file, replace_text...)   │
│       │                                                                │
│       ├──► AgentLoop (src/agent/agent-loop.ts)                         │
│       │        (Active turn reasoning, compactor, completion evidence) │
│       │                                                                │
│       └──► UI Runtime: TEA TUI (src/ui/tea/index.ts)                   │
│                (Model-Update-View, Composer, Viewport, Diff, Palette)  │
│                                                                        │
│   [DEAD BLOCKS TO PRUNE]                                               │
│   ❌ src/ui/ink/            (React/Ink VDOM TUI)                       │
│   ❌ src/control-plane/     (Unwired shadow state machine)             │
│   ❌ src/computer/          (Unregistered desktop control)             │
│   ❌ src/mcp/               (Disconnected browser/REA MCP clients)     │
│   ❌ src/execution/substrate-factory.ts (Single-caller wrapper)       │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 4. GitNexus Findings

[graph] GitNexus impact analysis confirms:
- `renderInkApp` (`src/ui/ink/index.tsx`): 0 upstream callers in production code.
- `EvidenceDrivenControlPlane` (`src/control-plane/`): 0 upstream callers in runtime engine.
- `ComputerController` (`src/computer/`): 0 upstream callers in runtime tools.
- `McpManager` (`src/mcp/mcp-manager.ts`): only referenced by `kernel.ts` registration which delegates to no-op registry hooks.
- `ExecutionSubstrateFactory` (`src/execution/substrate-factory.ts`): 0 callers across the repository.

---

## 5. Statement-Level PDG Findings

[verified]
- In `src/kernel/kernel.ts`:
  - `browserMcp` and `reaMcp` fields are initialized in `createContext()` and `init()`, but their registrations into `tools` are no-ops.
  - Removing `browserMcp` and `reaMcp` simplifies `KernelContext`, reduces startup latency, and avoids launching external MCP processes.
- In `src/tools/registry.ts`:
  - `attachBrowserManager`, `attachReaManager`, and `getComputerController` can be safely removed without breaking any callers.
- In `src/agent/completion-policy.test.ts`:
  - Parity test comparing `AcceptancePolicy.checkHardInvariants` can be removed while retaining all primary `FinalAnswerGuard` tests.
- In `src/agent/policy-consistency.test.ts`:
  - Standalone unit tests for `CompletionGate` and `AcceptancePolicy` can be removed while preserving all workspace policy consistency checks.

---

## 6. Proposed Changes

### Phase 1: Prune Deprecated React/Ink Subsystem
- Delete directory `src/ui/ink/`
- Delete `src/test-ink-tui.tsx`
- Delete `src/ui/tui-theme.test.tsx` (which imports `ink`)
- In `src/ui/tui-theme.ts`: simplify by removing unused `inkColors`
- In `package.json`: remove `ink`, `react`, `@types/react` from devDependencies

### Phase 2: Prune Shadow Control Plane Subsystem
- Delete directory `src/control-plane/`
- In `src/agent/completion-policy.test.ts`: remove `AcceptancePolicy` import and its single parity assertion
- In `src/agent/policy-consistency.test.ts`: remove `control-plane` imports and unit assertions
- In `src/agent/policy-guidance-regression.test.ts`: remove `AdaptiveComputeController` import and test case

### Phase 3: Prune Computer-Use Subsystem
- Delete directory `src/computer/`
- In `src/tools/registry.ts`: remove `computerController` field and `getComputerController()` method

### Phase 4: Prune Disconnected MCP Infrastructure
- Delete directory `src/mcp/`
- In `src/kernel/kernel.ts`: remove `McpManager` and `ReaMcpManager` imports, context fields, and lifecycle calls
- In `src/tools/registry.ts`: remove `attachBrowserManager` and `attachReaManager`
- In `package.json`: remove `@playwright/mcp` dependency

### Phase 5: Prune Unused Execution Substrate Factory
- Delete `src/execution/substrate-factory.ts`
- In `src/execution/index.ts`: remove re-export of `substrate-factory.js`

### Phase 6: Prune Ad-Hoc Root Scratch Scripts
- Delete unreferenced scratch runners:
  - `src/test-cognitive-harness.ts`
  - `src/test-collapse-explore.ts`
  - `src/test-context-management.ts`
  - `src/test-epistemic-investigation.ts`
  - `src/test-error-detective.ts`
  - `src/test-interrupted-session.ts`
  - `src/test-input-prompt-fixes.ts`

---

## 7. Implementation Sequence

1. **Step 1: MCP Subsystem Decoupling & Removal**
   - Clean `src/kernel/kernel.ts` and `src/tools/registry.ts`.
   - Remove `src/mcp/` and `@playwright/mcp`.
   - Run `npx tsc --noEmit` to verify type cleanliness.
2. **Step 2: Computer-Use Subsystem Removal**
   - Clean `src/tools/registry.ts`.
   - Remove `src/computer/`.
   - Run `npx tsc --noEmit`.
3. **Step 3: Execution Substrate Factory Removal**
   - Clean `src/execution/index.ts`.
   - Remove `src/execution/substrate-factory.ts`.
   - Run `npx tsc --noEmit`.
4. **Step 4: Shadow Control-Plane Removal**
   - Update `completion-policy.test.ts`, `policy-consistency.test.ts`, and `policy-guidance-regression.test.ts`.
   - Remove `src/control-plane/`.
   - Run `npm run test:completion` and `npx tsc --noEmit`.
5. **Step 5: Deprecated Ink TUI Removal**
   - Remove `src/ui/ink/`, `src/test-ink-tui.tsx`, `src/ui/tui-theme.test.tsx`.
   - Clean `src/ui/tui-theme.ts`.
   - Remove `ink`, `react`, `@types/react` from `package.json`.
   - Run `npm run test:tea` to confirm TEA UI is 100% operational.
6. **Step 6: Ad-Hoc Root Scratch Scripts Removal**
   - Remove obsolete `src/test-*.ts` scratch files.
   - Run full test suite (`npm test`).

---

## 8. Test Strategy

- `npx tsc --noEmit`: Compiler verification across all remaining modules.
- `npm run test:tea`: Verify all 146 TEA TUI tests pass without any React/Ink dependency.
- `npm run test:compaction`: Verify budget and compaction policies pass.
- `npm run test:completion`: Verify completion policy passes after control-plane decoupling.
- `npm test`: Verify comprehensive test suite health.

---

## 9. Risk Analysis and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `composer-model.ts` breaking from missing input line editor | High | Explicitly retain `src/ui/input-line-editor.ts` which is imported by TEA. |
| Kernel lifecycle regression when removing `McpManager` | Medium | Verify `kernel.init()` and `kernel.dispose()` run cleanly without MCP calls. |
| Test failures from deleted `control-plane` imports | Low | Verified that only 3 test files reference control-plane; clean up test assertions prior to deletion. |

---

## 10. Rollback Plan

- If any regressions occur, revert cleanly using Git working tree checkpoint (`git checkout HEAD -- <files>`).
- Each step is verified by `tsc` and test runs before proceeding to the next.

---

## 11. Implementation Context

```yaml
context_pack:
  schema_version: 2
  target_repo: "Minus_CLI"
  verified_at_commit: "a47f8916ca80c5b818da2f8ef80f10cc600797de"
  deletions:
    - "src/ui/ink/"
    - "src/control-plane/"
    - "src/computer/"
    - "src/mcp/"
    - "src/execution/substrate-factory.ts"
    - "src/test-cognitive-harness.ts"
    - "src/test-collapse-explore.ts"
    - "src/test-context-management.ts"
    - "src/test-epistemic-investigation.ts"
    - "src/test-error-detective.ts"
    - "src/test-interrupted-session.ts"
    - "src/test-input-prompt-fixes.ts"
    - "src/test-ink-tui.tsx"
    - "src/ui/tui-theme.test.tsx"
  modifications:
    - "package.json"
    - "src/kernel/kernel.ts"
    - "src/tools/registry.ts"
    - "src/execution/index.ts"
    - "src/ui/tui-theme.ts"
    - "src/agent/completion-policy.test.ts"
    - "src/agent/policy-consistency.test.ts"
    - "src/agent/policy-guidance-regression.test.ts"
```

---

## 12. Assumptions and Open Questions

- Assumption: `src/test-latency-optimization.ts` is retained because `package.json` contains script `"test:latency": "tsx src/test-latency-optimization.ts"`.
- Assumption: `src/ui/tea/` is the sole production UI and requires zero React/Ink components.

---

## 13. Definition of Done

1. All 5 dead subsystems and unreferenced scratch files are completely deleted from `src/`.
2. `package.json` is freed of 4 unused dependencies (`@playwright/mcp`, `ink`, `react`, `@types/react`).
3. `npx tsc --noEmit` exits with 0 errors.
4. `npm run test:tea` passes 100% (all 146 tests).
5. `npm run test:completion` passes.
6. `npm run test:compaction` passes.
7. Git working directory is in a verified, clean, buildable state.
