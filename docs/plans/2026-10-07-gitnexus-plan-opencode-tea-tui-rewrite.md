# GitNexus Engineering Plan

> Task: Complete Architectural Rewrite of Minus CLI TUI to Adopt OpenCode's Ecosystem (TypeScript + Bubble Tea / The Elm Architecture), Rendering Mechanism (Lip Gloss), and Full-Screen Terminal Experience
> Evidence verified at commit 7809fbb15a066d301be0ebb28bad86669322adcb; GitNexus index fresh (active background lock observed on LadybugDB, fell back to authoritative source verification).
> Evidence provenance schema 2; global dirty digest 030df97638f8629020e36331e61949effbba22953ce373197240e29ddd2b3ccd; cited-path manifest 20 sorted entries; exact generated plan path excluded.

## 1. Objective

Architecturally redesign and completely rewrite the Minus CLI terminal user interface (TUI) to match the proven, high-performance architecture of **OpenCode**:
1. **Ecosystem & Runtime**: Replace the React/Ink virtual-DOM layer with a pure TypeScript port of Charmbracelet's **Bubble Tea** (via `@oakoliver/bubbletea`) and declarative styling with **Lip Gloss** (`@oakoliver/lipgloss`), eliminating React reconciler overhead, fiber memory consumption, and cursor synchronization glitches.
2. **Architectural Philosophy (The Elm Architecture - TEA)**: Transition from ad-hoc reactive state buses and React hooks to a strictly unidirectional **Model-Update-View** pattern with a hierarchical Model tree (`RootModel`, `ViewportModel`, `ComposerModel`, `SidebarModel`, `PaletteModel`, `DiffViewerModel`, `StatuslineModel`).
3. **Rendering Mechanism**: Pure string-based ANSI terminal rendering with 60 FPS frame coalescing, responsive layout constraint math, syntax highlighting, and flicker-free token streaming.
4. **Terminal Experience (OpenCode UX Parity)**:
   - Full-Screen Alternate Screen Buffer (`altscreen`) lifecycle with clean restoration on exit.
   - Central **Leader Key System (`Ctrl+X`)** with mnemonic shortcuts: `Ctrl+X C` (Compact Session), `Ctrl+X E` (External Editor composition), `Ctrl+X Q` (Clean Quit), `Ctrl+X B` (Toggle Sidebar), `Ctrl+X D` (Toggle Diff View).
   - Mode switching via `Tab` (Explore/Plan Mode vs Implement/Build Mode).
   - Fuzzy Command Palette (`Ctrl+P`) for instant command execution.
   - Dual-Mode Architecture: Full interactive TUI (`minus`) vs Headless CLI execution (`minus run "<prompt>"` / `--headless`).

## 2. Current Behaviour

[verified] In the current codebase, Minus CLI maintains two overlapping UI layers:
1. **Direct ANSI / Readline Stream (`src/ui/cli-ui.ts`, 2893 lines)**:
   - Contains 50+ imperative methods on the `CLI` namespace directly calling `console.log` and manipulating stdout.
   - Uses Node.js `readline` (`src/index.ts:886`) for user input prompts with custom Tab completion for slash commands and file mentions.
   - Suffers from interleaving issues when agent background tasks or token streams output during user prompt typing.
2. **Experimental Ink React TUI (`src/ui/ink/`)**:
   - Uses Ink (`package.json:59`, `ink: ^7.1.1`) and React (`package.json:65`, `react: ^19.2.8`).
   - Manages state via `TuiStore` (`src/ui/ink/tui-store.ts:299-370`), an `EventEmitter` with Redux-like dispatching.
   - Connects to `AgentKernel` events via `bindKernel` (`src/ui/ink/tui-store.ts:325-450`).
   - Components like `App.tsx`, `StepStream.tsx`, `LiveReasoningBox.tsx`, and `InputPromptBar.tsx` suffer from React reconciliation latency when receiving token chunks at high frequencies, and multi-line cursor manipulation is brittle.
3. [verified] The primary entry point (`src/index.ts:823-950`) defaults to the legacy readline / `cli-ui.ts` loop rather than a full-screen interactive app.

## 3. Relevant Architecture

The proposed architecture adopts **The Elm Architecture (TEA)** natively in TypeScript:

```text
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                 MINUS CLI TEA ARCHITECTURE                              │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                         │
│   Terminal Raw Input / Signals                 AgentKernel Event Bus                    │
│        (KeyMsg, Mouse, Resize)                  (step, tool, thought, token, final)     │
│                   │                                      │                              │
│                   ▼                                      ▼                              │
│        ┌─────────────────────┐                 ┌────────────────────┐                   │
│        │   Input Translator  │                 │  KernelTEAAdapter  │                   │
│        └──────────┬──────────┘                 └─────────┬──────────┘                   │
│                   │                                      │                              │
│                   └──────────────────┬───────────────────┘                              │
│                                      │ Msg (Discriminated Union)                        │
│                                      ▼                                                  │
│                        ┌──────────────────────────┐                                     │
│                        │     Program.Send(msg)    │                                     │
│                        └─────────────┬────────────┘                                     │
│                                      │                                                  │
│                                      ▼                                                  │
│     ┌─────────────────────────────────────────────────────────────────────────┐         │
│     │                           RootModel.Update()                            │         │
│     │                                                                         │         │
│     │   ┌───────────────┐  ┌───────────────┐  ┌───────────────┐  ┌──────────┐ │         │
│     │   │ ViewportModel │  │ ComposerModel │  │  SidebarModel │  │ ...Modal │ │         │
│     │   └───────────────┘  └───────────────┘  └───────────────┘  └──────────┘ │         │
│     └────────────────────────────────┬────────────────────────────────────────┘         │
│                                      │                                                  │
│                         [New Model, Cmd (Side-Effects)]                                 │
│                                      │                                                  │
│                                      ▼                                                  │
│     ┌─────────────────────────────────────────────────────────────────────────┐         │
│     │                            RootModel.View()                             │         │
│     │  • Lip Gloss Styles (Borders, Padding, Flex Layout, Colors)             │         │
│     │  • Pure String ANSI Output (No Virtual DOM)                             │         │
│     └────────────────────────────────┬────────────────────────────────────────┘         │
│                                      │                                                  │
│                                      ▼                                                  │
│                     Full-Screen Terminal Alternate Buffer                               │
│                         ([?1049h / 60 FPS Coalesced)                                │
│                                                                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### Core Architectural Layers:
1. **TEA Core Engine (`src/ui/tea/core/`)**:
   - `Program`: Controls terminal raw mode, alternate screen buffer, signal trapping (`SIGINT`, `SIGWINCH`), and the 60 FPS render scheduler.
   - `Cmd`: First-class asynchronous command abstraction. Functions returning `Promise<Msg>` executed off the main update cycle.
   - `Sub`: Event subscriptions (e.g., ticking timer, kernel event bus bridge).
2. **Hierarchical Model Tree (`src/ui/tea/models/`)**:
   - `RootModel`: Holds global modal state, active focus zone, leader-key buffer, and delegates to children.
   - `ViewportModel`: Virtualized scrolling container for steps, thoughts, tool diffs, and execution results.
   - `ComposerModel`: Input editor supporting multi-line editing, history browsing, `@` mentions, and slash command autocompletion.
   - `SidebarModel`: Collapsible side panel listing session history, context tokens, active tools, and memory invariants.
   - `DiffViewerModel`: Full-featured unified/split diff previewer with syntax highlighting.
   - `PaletteModel`: Fuzzy-search command palette (`Ctrl+P`).
   - `StatuslineModel`: Header and footer telemetry lines.
3. **Styling & Layout (`src/ui/tea/styles/`)**:
   - Powered by `@oakoliver/lipgloss` (Lip Gloss in TypeScript), defining consistent borders, colors, alignment, and flex layouts.
4. **Kernel Decoupling Bridge (`src/ui/tea/kernel-bridge.ts`)**:
   - Bridges `AgentKernel.ctx.events` directly into TEA `KernelMsg` dispatches without tight coupling.

## 4. GitNexus Findings

[graph] GitNexus exploration and cluster mapping revealed:
- **Module Clusters**:
  - `Ui` (170 symbols) and `Ink` (28 symbols) currently contain the UI logic.
  - `Kernel` (`src/kernel/kernel.ts`) defines `KernelEvents` with 20+ strongly-typed events including `step:before`, `step:after`, `tool:before`, `tool:after`, `model:thinking:start`, `model:thought`, `model:final_answer`, `model:usage`, and `model:retry`.
- **Primary Touchpoints**:
  - `src/ui/ink/tui-store.ts:bindKernel`: Currently binds to `kernel.ctx.events`. This logic will be migrated into `KernelTEAAdapter`.
  - `src/ui/ink/components/input-line-editor.ts`: Contains grapheme-aware text editing logic that can be directly reused inside `ComposerModel`.
  - `src/index.ts`: Initializes the REPL loop via readline. This will be replaced with `launchTeaApp(kernel, options)`.

## 5. Statement-Level PDG Findings

[verified] Source-verified data and control flows:
- **Token Stream Flow**:
  - `AgentKernel` emits `model:thought` on each streaming chunk (`src/kernel/kernel.ts:54`).
  - Currently, `StreamBatcher` (`src/ui/ink/tui-store.ts:329`) flushes to `TuiStore` at ~30 FPS to prevent React re-render flooding.
  - In TEA, token chunks are dispatched as `ThinkingChunkMsg(chunk)`. The `ViewportModel` appends the string to its internal buffer, and rendering occurs only on the coalesced render loop, completely preventing buffer overrun.
- **Cancellation Flow**:
  - `Ctrl+C` / Leader key `Ctrl+X Q` triggers an abort command (`src/ui/ink/tui-store.ts:321`, `store.abortCurrent()`).
  - The TEA `Update` function intercepts `KeyMsg('ctrl+c')`, dispatches `TaskAbortCmd`, which invokes `kernel.cancelCurrentTask()`, transitions UI status to `isAborting`, and renders the cancellation banner without tearing the terminal screen.

## 6. Proposed Changes

### 1. Dependencies (`package.json`)
- Add `@oakoliver/bubbletea` and `@oakoliver/lipgloss` (or bundle an in-tree pure-TS TEA engine with zero external native dependencies).
- Mark `ink` and `react` for deprecation/removal in the UI layer.

### 2. New Subsystem: `src/ui/tea/`
- `src/ui/tea/types.ts`:
  - Define `Msg` union: `KeyMsg`, `WindowSizeMsg`, `TickMsg`, `KernelEventMsg`, `LeaderKeyMsg`, `PaletteSelectMsg`, `ModeToggleMsg`.
  - Define `Model` interfaces: `RootModel`, `ViewportState`, `ComposerState`, `SidebarState`, `DiffState`.
- `src/ui/tea/styles/theme.ts`:
  - Lip Gloss style definitions for monochromatic palette, borders, status badges, diff highlighting, and spinners.
- `src/ui/tea/models/root-model.ts`:
  - Root coordinator implementing TEA `init()`, `update(msg, model)`, and `view(model)`.
  - Manages active focus (Viewport vs Composer vs Sidebar vs Palette).
  - Implements OpenCode's **Leader Key System** (`Ctrl+X` buffer with timeout reset).
- `src/ui/tea/models/viewport-model.ts`:
  - Virtualized scrollable conversation view.
  - Formats steps, tool call boxes, thinking accordions, and final answers as ANSI strings.
- `src/ui/tea/models/composer-model.ts`:
  - Multi-line text editor with cursor positioning, history traversal, `@` mention popup, and slash command autocompletion.
- `src/ui/tea/models/sidebar-model.ts`:
  - Collapsible side drawer displaying sessions, memory invariants, modified files, and system statistics.
- `src/ui/tea/models/palette-model.ts`:
  - Fuzzy command palette triggered by `Ctrl+P`.
- `src/ui/tea/models/diff-model.ts`:
  - Interactive file diff inspector supporting syntax highlighting and side-by-side or unified view.
- `src/ui/tea/kernel-bridge.ts`:
  - `KernelTEAAdapter`: Subscribes to `kernel.ctx.events` and pushes `KernelMsg` instances into the Bubble Tea event queue.
- `src/ui/tea/external-editor.ts`:
  - Implements `Ctrl+X E` support: pauses the terminal raw mode, enters primary screen, launches `$EDITOR` (or Vim/Nano) on a temp file, reads the result, and returns to alternate screen buffer.
- `src/ui/tea/index.ts`:
  - Exports `startInteractiveTui(kernel, options)` and `runHeadlessCli(kernel, prompt, options)`.

### 3. CLI Orchestration Migration (`src/index.ts`)
- Add CLI flag check:
  - If `minus run "<prompt>"` or `--headless` -> run Headless Mode (plain stream output for CI/CD).
  - Default `minus` -> launch full-screen Bubble Tea TUI.
- Deprecate direct readline creation in `src/index.ts`.

## 7. Implementation Sequence

### Phase 1: Bubble Tea / TEA Foundation & Type System
- Step 1: Install or scaffold TEA core (`@oakoliver/bubbletea`, `@oakoliver/lipgloss`) and define core types in `src/ui/tea/types.ts`.
- Step 2: Implement `src/ui/tea/styles/theme.ts` with Lip Gloss token styling matching Minus CLI's dark minimal aesthetic.
- Step 3: Implement `KernelTEAAdapter` in `src/ui/tea/kernel-bridge.ts` mapping all 20+ `AgentKernel` events to TEA `KernelMsg` types.

### Phase 2: Core Components & Models
- Step 4: Implement `ViewportModel` with line virtualizer, ANSI truncation, and auto-scroll pins.
- Step 5: Implement `ComposerModel` utilizing existing line editor logic from `input-line-editor.ts` with slash command and `@` mention popups.
- Step 6: Implement `SidebarModel` and `StatuslineModel` for token budget, mode badges, and active session info.
- Step 7: Implement `DiffViewerModel` with syntax coloration and collapsible hunks.

### Phase 3: OpenCode Interaction Features (Leader Key & Modals)
- Step 8: Implement Leader Key state machine (`Ctrl+X` prefix buffer + action routing) in `RootModel`.
- Step 9: Implement Command Palette (`Ctrl+P`) with fuzzy filtering over slash commands and session actions.
- Step 10: Implement External Editor launcher (`Ctrl+X E`) with terminal raw mode suspension and restoration.
- Step 11: Implement Mode Switching (`Tab`) between Explore/Plan and Implement/Build modes.

### Phase 4: Integration & Dual-Mode Wiring
- Step 12: Wire `startInteractiveTui` and `runHeadlessCli` into `src/index.ts`.
- Step 13: Add comprehensive unit tests in `src/ui/tea/__tests__/` covering all TEA `update()` transitions and `view()` outputs.
- Step 14: Deprecate legacy Ink components and clean up unused ANSI stdout routines.

## 8. Test Strategy

1. **TEA Unit Tests (`src/ui/tea/__tests__/tea-reducer.test.ts`)**:
   - Pure function tests: verify `update(msg, model)` transitions for all messages without any I/O:
     - `KeyMsg('ctrl+x')` followed by `KeyMsg('c')` -> dispatches compact session command.
     - `KeyMsg('tab')` -> toggles between `EXPLORE` and `IMPLEMENT` modes.
     - `KernelMsg.thinkingChunk` -> appends correctly to thinking buffer.
     - `KeyMsg('ctrl+p')` -> opens Command Palette modal and captures focus.
2. **View Rendering Tests (`src/ui/tea/__tests__/tea-view.test.ts`)**:
   - Snapshot tests for `view(model)`: ensure Lip Gloss produces expected ANSI strings for given terminal dimensions (`80x24`, `120x40`).
   - Terminal resize tests: verify that resizing to smaller heights does not throw exceptions or corrupt layout strings.
3. **External Editor & Abort Lifecycle Tests**:
   - Mock child process spawn for `$EDITOR` and verify that terminal mode switches cleanly.
   - Verify task abort sequence cleans state and releases kernel locks without zombie processes.
4. **Verification Commands**:
   - Run compilation: `npm run build` (`tsc`).
   - Run tests: `node --import tsx src/test-suite.ts`.

## 9. Risk and Impact Analysis

1. **Terminal Raw Mode & Windows ConPTY Compatibility**:
   - *Risk*: Windows Command Prompt / PowerShell historically has quirks with raw mode and alternate screen buffer escape sequences (`\x1b[?1049h`).
   - *Mitigation*: Ensure `supportsTerminalColor` and ConPTY VT processing are explicitly validated before switching buffers. Provide automatic fallback to linear streaming mode if terminal is not a TTY.
2. **External Editor Suspension**:
   - *Risk*: Suspending raw mode to launch Vim/Nano can leave the terminal in an inconsistent state if the child process crashes.
   - *Mitigation*: Wrap editor spawn in a `try...finally` block that unconditionally restores raw mode and re-enters the alternate screen buffer.
3. **High-Frequency Token Flooding**:
   - *Risk*: Streaming LLM outputs at hundreds of tokens/sec might overload the TEA event queue.
   - *Mitigation*: Adopt the proven 60 FPS coalesced tick architecture (frame batching) so multiple token messages within a single frame only update the internal buffer without triggering redundant terminal writes.
4. **Downstream Consumers**:
   - All external tools, agent loop policies, and kernel services communicate through `AgentKernel.ctx.events` and are completely decoupled from UI implementation details.

## 10. Files Expected to Change

| File | Symbols | Reason |
| ---- | ------- | ------ |
| `package.json` | `dependencies` | Add `@oakoliver/bubbletea`, `@oakoliver/lipgloss`; phase out `ink` |
| `src/ui/tea/types.ts` | `Msg`, `Model`, `Cmd` | Core TEA type definitions |
| `src/ui/tea/styles/theme.ts` | `lipGlossTheme` | Lip Gloss styling tokens and layout rules |
| `src/ui/tea/models/root-model.ts` | `RootModel`, `update`, `view` | Top-level compositor and leader-key router |
| `src/ui/tea/models/viewport-model.ts` | `ViewportModel` | Virtualized conversation and step viewer |
| `src/ui/tea/models/composer-model.ts` | `ComposerModel` | Multi-line prompt input with autocompletion |
| `src/ui/tea/models/sidebar-model.ts` | `SidebarModel` | Collapsible context & session drawer |
| `src/ui/tea/models/palette-model.ts` | `PaletteModel` | Fuzzy command palette (`Ctrl+P`) |
| `src/ui/tea/models/diff-model.ts` | `DiffViewerModel` | Syntax-highlighted diff previewer |
| `src/ui/tea/models/statusline-model.ts` | `StatuslineModel` | Telemetry and status bar |
| `src/ui/tea/kernel-bridge.ts` | `KernelTEAAdapter` | Decoupled event bridge from `AgentKernel` to TEA |
| `src/ui/tea/external-editor.ts` | `openExternalEditor` | Subprocess launcher for `$EDITOR` composition |
| `src/ui/tea/index.ts` | `launchInteractiveTui`, `runHeadlessCli` | Main entry points for the new UI subsystem |
| `src/index.ts` | REPL loop | Integrate `launchInteractiveTui` and headless runner |

## 11. Reusable Implementation Context

```yaml
implementation_context:
  task_summary: "Complete architectural rewrite of Minus CLI TUI to adopt OpenCode's TypeScript + Bubble Tea (The Elm Architecture), Lip Gloss rendering, and Full-Screen Terminal UX."
  acceptance_criteria:
    - "Replace React/Ink with pure TypeScript Bubble Tea and Lip Gloss styling."
    - "Implement strictly unidirectional Model-Update-View architecture with hierarchical models."
    - "Deliver full-screen alternate buffer (altscreen) with zero flicker and 60 FPS coalescing."
    - "Implement OpenCode Leader Key system (Ctrl+X with C, E, Q mnemonics)."
    - "Implement Command Palette (Ctrl+P) and Mode Toggling (Tab between Explore and Implement)."
    - "Support Dual-Mode execution: full-screen TUI vs headless CLI (minus run <prompt>)."

  evidence_provenance: {
      "schema_version": 2,
      "head_commit": "7809fbb15a066d301be0ebb28bad86669322adcb",
      "generated_plan_path": "docs/plans/2026-10-07-gitnexus-plan-opencode-tea-tui-rewrite.md",
      "global_dirty_digest": {
        "algorithm": "sha256",
        "canonicalization": "gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records",
        "value": "030df97638f8629020e36331e61949effbba22953ce373197240e29ddd2b3ccd"
      },
      "cited_path_manifest": [
        {
          "path": "package.json",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:2fa61d2d45265858ad375b32d62ca16625469491fc9cae8f42d0d47208b0b9a9",
          "index_digest": "sha256:2fa61d2d45265858ad375b32d62ca16625469491fc9cae8f42d0d47208b0b9a9",
          "worktree_digest": "sha256:2fa61d2d45265858ad375b32d62ca16625469491fc9cae8f42d0d47208b0b9a9",
          "untracked_digest": "absent"
        },
        {
          "path": "src/index.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:a4f28ce3c52981a94e21395a9c48de9a0c50d3a685e45b4bf8a0a3d1af5f1047",
          "index_digest": "sha256:a4f28ce3c52981a94e21395a9c48de9a0c50d3a685e45b4bf8a0a3d1af5f1047",
          "worktree_digest": "sha256:9dfa9357224b2be1e9204fef4b4665d169fca24271fa830f186178e3dc7ef070",
          "untracked_digest": "absent"
        },
        {
          "path": "src/kernel/kernel.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:7bd47e8f76bf3347c2abcc9a6ccf3b63d94dde1912b1b17dbcd2131f561c10ef",
          "index_digest": "sha256:7bd47e8f76bf3347c2abcc9a6ccf3b63d94dde1912b1b17dbcd2131f561c10ef",
          "worktree_digest": "sha256:d921645abfe4f669b1a3f1fa0806a08de172651da6de54baefef3c17095f249b",
          "untracked_digest": "absent"
        },
        {
          "path": "src/test-ink-tui.tsx",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:df6007d36942ad666ce5fe22f0f9d0fc41689a4bf163c3fd96b9b9ac571ee095",
          "index_digest": "sha256:df6007d36942ad666ce5fe22f0f9d0fc41689a4bf163c3fd96b9b9ac571ee095",
          "worktree_digest": "sha256:7e5108c514271c5dbe0070eb5ac6e10bdf0e40fb7b6cb6ac071e789ce903a05f",
          "untracked_digest": "absent"
        },
        {
          "path": "src/test-input-prompt-fixes.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:84a156f0c1d5e1bfddd2ee000e399320b0677eacdf8f85599886548f486ec893",
          "index_digest": "sha256:84a156f0c1d5e1bfddd2ee000e399320b0677eacdf8f85599886548f486ec893",
          "worktree_digest": "sha256:0b4d7fb450dcb5ea9a5469e4aad187e1421ef8939380d935ddc0c6d9f0f3903a",
          "untracked_digest": "absent"
        },
        {
          "path": "src/ui/cli-ui.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:3fe7234a9d2fcb8b605b97676329a0ff0f0041b84b1e8a0205dba24a26710457",
          "index_digest": "sha256:3fe7234a9d2fcb8b605b97676329a0ff0f0041b84b1e8a0205dba24a26710457",
          "worktree_digest": "sha256:61c23ed6fb368254791825c5032c682357f034ca9a9a869746c9e4411bc862e5",
          "untracked_digest": "absent"
        },
        {
          "path": "src/ui/compaction-status.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:6104af8155249277506f56177a280fc6b4a151860efa213b29ee1ca4b514e4f2",
          "index_digest": "sha256:6104af8155249277506f56177a280fc6b4a151860efa213b29ee1ca4b514e4f2",
          "worktree_digest": "sha256:1099d70d353ea74251638c68f53bb1851c7543108b543cd27921f96117643dd7",
          "untracked_digest": "absent"
        },
        {
          "path": "src/ui/ink/components/App.tsx",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:3c208bc8e4896d41f33dffdbb8d6b7ea53516527e198ee7c39644d101e90acd9",
          "index_digest": "sha256:3c208bc8e4896d41f33dffdbb8d6b7ea53516527e198ee7c39644d101e90acd9",
          "worktree_digest": "sha256:f6bb6c6bb8cc927e444d1d690973d9b0c14d0995c91e9c55edc67729b57b92d7",
          "untracked_digest": "absent"
        },
        {
          "path": "src/ui/ink/components/DiffPreviewBox.tsx",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:0a87a517db056d87075e2eec39a5b909becaeaebed58c7244716f0a717f2db21",
          "index_digest": "sha256:0a87a517db056d87075e2eec39a5b909becaeaebed58c7244716f0a717f2db21",
          "worktree_digest": "sha256:e9165ce4ef22197b7618df2be27f8956fb17665276c282a5766fc0a91f131f6d",
          "untracked_digest": "absent"
        },
        {
          "path": "src/ui/ink/components/Header.tsx",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:904d0f1128779fb597d49a106f8bed942fe6b6d101ecb1ebe5517f72194977a0",
          "index_digest": "sha256:904d0f1128779fb597d49a106f8bed942fe6b6d101ecb1ebe5517f72194977a0",
          "worktree_digest": "sha256:0ea6f3d4517493bc33faaf9073c41ba67218dd7968a93700b61ffbf582645c20",
          "untracked_digest": "absent"
        },
        {
          "path": "src/ui/ink/components/InputPromptBar.tsx",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:fa47efbf357237814981d35372a00c0d9ff04ce725f14db0925d0a56b0365c00",
          "index_digest": "sha256:fa47efbf357237814981d35372a00c0d9ff04ce725f14db0925d0a56b0365c00",
          "worktree_digest": "sha256:dec5dbf824ddf6c1d054aa274569f031cb6bf410947382f66f679a1da9c59147",
          "untracked_digest": "absent"
        },
        {
          "path": "src/ui/ink/components/LiveReasoningBox.tsx",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:c80f94a8f4bed90abc744430d774e6f5ee57282840646c55604a8e5ebdbd8949",
          "index_digest": "sha256:c80f94a8f4bed90abc744430d774e6f5ee57282840646c55604a8e5ebdbd8949",
          "worktree_digest": "sha256:c8e9c6fd51eed1022db28e5b61c49a9b36d47cb972b77e9481bce86ca2193595",
          "untracked_digest": "absent"
        },
        {
          "path": "src/ui/ink/components/PermissionPromptBox.tsx",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:4df8342a5f0b9322730dd77f6de77c7bc1fa1d54fc9a06f8a5ed520e1b48ada3",
          "index_digest": "sha256:4df8342a5f0b9322730dd77f6de77c7bc1fa1d54fc9a06f8a5ed520e1b48ada3",
          "worktree_digest": "sha256:7fae844084e74867f747d3271c1de3398be9904180da3be33283188f2c670223",
          "untracked_digest": "absent"
        },
        {
          "path": "src/ui/ink/components/StepStream.tsx",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:7fcd90c5cff2e76880759bb62cf8033ad88d7eebbe9e60b1d23e6b51454a566e",
          "index_digest": "sha256:7fcd90c5cff2e76880759bb62cf8033ad88d7eebbe9e60b1d23e6b51454a566e",
          "worktree_digest": "sha256:4a5cd9c8506c750c53b16239ae91c4701a94167289404bf8a85fc4d0cc12ded4",
          "untracked_digest": "absent"
        },
        {
          "path": "src/ui/ink/components/TelemetryBar.tsx",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:cd74006c21f7f85244f7f98d041d2fe3faa22178a201af18c6ae3d90f6713db3",
          "index_digest": "sha256:cd74006c21f7f85244f7f98d041d2fe3faa22178a201af18c6ae3d90f6713db3",
          "worktree_digest": "sha256:239034f9ead9eeb141c8fe5f51886f36e9de626328b35450e4d8cd5b1d84f9e5",
          "untracked_digest": "absent"
        },
        {
          "path": "src/ui/ink/components/input-line-editor.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:d7fbf9b84fbbac0f6e8d7592f79053202de1bcd904e3edaef7acd636a81f7359",
          "index_digest": "sha256:d7fbf9b84fbbac0f6e8d7592f79053202de1bcd904e3edaef7acd636a81f7359",
          "worktree_digest": "sha256:50ca98d6da609f4a727727850eab8eea21e1977b53d6712279d41e2462032f35",
          "untracked_digest": "absent"
        },
        {
          "path": "src/ui/ink/index.tsx",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:7641acbac142540788e4d5350558bb49ce224fb27778f6d2f6a8e9bde83257c8",
          "index_digest": "sha256:7641acbac142540788e4d5350558bb49ce224fb27778f6d2f6a8e9bde83257c8",
          "worktree_digest": "sha256:313de047097c99edd5a1ae4883c93bb3d693fb12e38498cf7283c14fbf492f54",
          "untracked_digest": "absent"
        },
        {
          "path": "src/ui/ink/tui-store.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:96d444041bd3f855c0218bd6cc0a684b17e670b01c2534712f47488566e47b54",
          "index_digest": "sha256:96d444041bd3f855c0218bd6cc0a684b17e670b01c2534712f47488566e47b54",
          "worktree_digest": "sha256:55ef7120a27406cdbb8efb9eae24193497e7834ce4c7a68f033f005fc22364bc",
          "untracked_digest": "absent"
        },
        {
          "path": "src/ui/ink/types.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:ccb6661782a3c8cf3453f30113fb9f4428ada4cffdc53a59994c8fdfc42a4485",
          "index_digest": "sha256:ccb6661782a3c8cf3453f30113fb9f4428ada4cffdc53a59994c8fdfc42a4485",
          "worktree_digest": "sha256:c22382f191d945c51b333efa59e8ab2769999b2c653b40b116772415f1ba9571",
          "untracked_digest": "absent"
        },
        {
          "path": "src/ui/tui-theme.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:4dac44c7479ce00399023ebb4640b3c713e62d38798ba76daf4876e5ee1f7e18",
          "index_digest": "sha256:4dac44c7479ce00399023ebb4640b3c713e62d38798ba76daf4876e5ee1f7e18",
          "worktree_digest": "sha256:9f444b3023d7069dfe981b2c8a5d6de138e8730791dc579b0012ec0039507629",
          "untracked_digest": "absent"
        }
      ]
    }

  primary_symbols:
    - symbol: "AgentKernel"
      file: "src/kernel/kernel.ts"
      lines: "36-80"
      role: "Central event bus emitting kernel lifecycle, tool, and model events."
    - symbol: "TuiStore"
      file: "src/ui/ink/tui-store.ts"
      lines: "299-370"
      role: "Legacy EventEmitter state store; logic to be adapted into RootModel & KernelTEAAdapter."
    - symbol: "InputPromptBar"
      file: "src/ui/ink/components/InputPromptBar.tsx"
      lines: "38-120"
      role: "Legacy prompt input; input editing algorithms to be reused in ComposerModel."
    - symbol: "CLI"
      file: "src/ui/cli-ui.ts"
      lines: "1-60"
      role: "Legacy ANSI formatting utilities to be replaced by Lip Gloss styles."

  related_symbols:
    - symbol: "LineEditorState"
      relationship: "REUSED_BY"
      relevance: "Grapheme-aware line editing primitives reused by ComposerModel."
    - symbol: "compactionStatus"
      relationship: "OBSERVED_BY"
      relevance: "Context compaction progress indicator bound to StatuslineModel."

  execution_path:
    - "1. User launches 'minus' in terminal -> Program initiates alternate screen buffer and raw mode."
    - "2. RootModel initializes child models (Viewport, Composer, Sidebar, Statusline)."
    - "3. KernelTEAAdapter connects to AgentKernel.ctx.events and translates events into TEA Msg."
    - "4. Program event loop processes incoming Msg, calls pure Update(msg, model) -> [model, cmd]."
    - "5. Program calls pure View(model), renders coalesced string buffer with Lip Gloss at 60 FPS."
    - "6. User presses Ctrl+X E -> Terminal raw mode temporarily suspended, $EDITOR opened, prompt populated upon editor exit."
    - "7. User exits via Ctrl+X Q or Ctrl+C -> Terminal alternate screen closed cleanly, cursor restored."

  pdg_constraints:
    - description: "Kernel event dispatching to TEA must be non-blocking and batched at 60 FPS."
      affected_statements: ["src/ui/ink/tui-store.ts:329-334"]
      implementation_consequence: "Use coalesced frame scheduler in Program rather than synchronous renders on every token."

  architectural_patterns:
    - pattern: "The Elm Architecture (TEA)"
      example_location: "@oakoliver/bubbletea"
      usage_guidance: "All state updates must be pure functions (Update); side-effects strictly confined to Cmd."
    - pattern: "Lip Gloss Declarative Layout"
      example_location: "@oakoliver/lipgloss"
      usage_guidance: "Use style composition and joinHorizontal/joinVertical instead of manual string padding."

  files_to_modify:
    - file: "package.json"
      symbols: ["dependencies"]
      intended_change: "Add Bubble Tea and Lip Gloss packages."
    - file: "src/ui/tea/types.ts"
      symbols: ["Msg", "Model", "Cmd"]
      intended_change: "Create TEA type system."
    - file: "src/ui/tea/models/root-model.ts"
      symbols: ["RootModel", "update", "view"]
      intended_change: "Create root compositor and leader-key state machine."
    - file: "src/index.ts"
      symbols: ["main", "startInteractiveSession"]
      intended_change: "Integrate Bubble Tea app runner and headless mode."

  tests:
    - file: "src/ui/tea/__tests__/tea-reducer.test.ts"
      scenarios:
        - "KeyMsg(ctrl+x) + KeyMsg(c) -> verify compact session action dispatched"
        - "KeyMsg(tab) -> verify mode toggled between EXPLORE and IMPLEMENT"
        - "KernelMsg(thought) -> verify viewport buffer appended correctly"
    - file: "src/ui/tea/__tests__/tea-view.test.ts"
      scenarios:
        - "Render view at 80x24 -> verify valid ANSI output without wrapping glitches"

  verification_commands:
    - "npm run build"
    - "node --import tsx src/test-suite.ts"

  risks:
    - "Windows terminal ConPTY quirks with alternate buffer"
    - "Terminal state desynchronization on editor crash"
    - "Token flood latency without frame coalescing"

  assumptions:
    - "A pure TypeScript port of Bubble Tea / TEA can run in standard Node.js without native binaries."
    - "AgentKernel event bus remains stable and unchanged."

  open_questions:
    - "Should mouse wheel scrolling in ViewportModel be enabled by default across all terminal emulators?"

  avoid:
    - "Do not introduce React reconcilers or virtual DOM in the new UI subsystem."
    - "Do not modify AgentKernel core logic; preserve complete event bus decoupling."
```

## 12. Assumptions and Open Questions

### Confirmed Facts:
- [verified] Minus CLI currently depends on `ink` and `react` in `package.json`.
- [verified] The primary interactive loop in `src/index.ts` uses readline directly rather than an alternate-screen interactive TUI.
- [verified] OpenCode utilizes Go + Bubble Tea + Lip Gloss with The Elm Architecture, full-screen alternate buffer, and a `Ctrl+X` leader key system.
- [verified] The `AgentKernel` exposes an `EventEmitter` with comprehensive lifecycle events, making a decoupled UI replacement straightforward.

### Assumptions:
- [assumed] `@oakoliver/bubbletea` and `@oakoliver/lipgloss` (or an in-tree TEA engine) provide 100% feature parity for terminal raw mode, ANSI formatting, and signal handling across Windows, macOS, and Linux.

### Open Questions:
- Should we provide a backward-compatibility toggle (`--ui=ink` vs `--ui=bubbletea`) during the transition phase, or complete an immediate clean break? (Recommendation: immediate clean break in a dedicated branch to avoid dual maintenance overhead).

## 13. Definition of Done

1. **TEA Subsystem Functional**: `src/ui/tea/` is fully implemented with `RootModel`, `ViewportModel`, `ComposerModel`, `SidebarModel`, `DiffViewerModel`, `PaletteModel`, and `StatuslineModel`.
2. **OpenCode UX Parity**:
   - Full-screen alternate buffer (`altscreen`) active during interactive sessions.
   - Leader key (`Ctrl+X`) functions reliably for `Ctrl+X C` (compact), `Ctrl+X E` (external editor), `Ctrl+X Q` (quit).
   - Command palette opens on `Ctrl+P` and executes slash commands.
   - Mode toggles between Explore and Implement on `Tab`.
   - Dual-mode support verified: `minus` enters TUI; `minus run "<prompt>"` runs headlessly.
3. **Decoupled Event Bus**: `KernelTEAAdapter` processes all `AgentKernel` events without dropping or lagging on fast token streams.
4. **Test Suite Green**: 100% of unit tests for TEA reducers and views pass, and `npm run build` compiles with zero TypeScript errors.
