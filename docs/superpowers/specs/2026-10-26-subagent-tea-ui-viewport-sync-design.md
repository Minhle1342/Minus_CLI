# Subagent Tea UI Viewport Sync & Non-Intrusive Orchestration UX

## 1. Intent & Context

When the main agent spawns subagents, their execution output is currently rendered via legacy CLI/Ink ANSI codes printed directly to `stdout`. In the interactive Tea UI, this captured text leaks into the terminal or corrupts the subagent tab viewport with raw escape sequences and carriage return spinners (`\r`). Additionally, subagent tabs pollute the primary session tab strip at the top of the screen, and sensitive operations can trigger interactive permission modals that halt background subagent execution.

This project delivers a unified, structured, non-intrusive subagent user experience within the Tea UI:
- Subagent execution is structured as clean Tea UI `TranscriptEntry` elements (`step`, `thinking`, `tool_call`, `tool_result`, `answer`).
- Subagent tabs are hidden from both the primary top tab strip and the general `Ctrl+T` Sessions Modal.
- A dynamic indicator appears on the bottom shortcut bar:
  - While subagents are active: displays `"● Subagent working"` in **purple**.
  - Once all subagents have completed: transitions to `"✓ Subagent (All done)"` in **green**.
  - Clicking this text (or pressing a dedicated shortcut) opens the Subagent Selector Modal.
- Selecting a subagent in the modal switches to a full-screen, clean Tea UI transcript view for that subagent, with `Esc` returning instantly to the main active session.
- Subagents automatically receive full session approval from genesis, running autonomously without interactive permission prompts.

---

## 2. Goals, Non-Goals, & Anti-Goals

### Goals
1. **Clean Tea UI Transcripts for Subagents**: Stream subagent events (`model:thinking`, `tool:call`, `tool:result`, `step`, `answer`) directly into structured `TranscriptEntry` objects; suppress legacy raw ANSI/Ink `stdout` strings during subagent execution.
2. **Hidden from Top Session Strip & `Ctrl+T`**: Only primary user sessions appear in `sessionTabStripView` and the general `Ctrl+T` Sessions Modal; tabs with `subagent: true` are managed exclusively via the Subagent Selector Modal.
3. **Dynamic Statusline Indicator**:
   - While subagents are running: displays `color(tokyoNight.purple, '● Subagent working')` (or with count if multiple: `● Subagent working (N)`).
   - When all subagents finish: transitions to `color(tokyoNight.green, '✓ Subagent (All done)')`.
   - Mouse click hit-testing is supported in both states to open the modal.
4. **Subagent Selector Modal**: Clicking the indicator opens a centered modal listing active and completed subagents (with ID, objective brief, status indicator: yellow for working, green for completed, red for failed, and step count).
5. **Full-Screen Transcript View**: Selecting a subagent in the modal switches the viewport to view that subagent's full transcript (supporting scrolling, `/collapse` CoT toggle). Pressing `Esc` returns directly to the main active session.
6. **Auto-Approved Session Authority**: Subagents are automatically granted session-wide permission approval at spawn time (`auto_approved: true` in `PermissionManager`), executing standard workspace mutations and commands without permission prompts. Hard security prohibitions (User Rule 2: git push to main, destructive system commands) remain strictly hard-denied.

### Non-Goals
- Interactive prompt composition inside a subagent session (subagent tabs remain read-only inspection views; composer is replaced with a clear read-only navigation notice).
- Overriding core security safety policies (hard policy gates against destructive commands and main branch pushes remain strictly enforced).

### Anti-Goals
- Freezing or corrupting the main agent's viewport when multiple background subagents stream output concurrently.
- Breaking existing kernel session persistence or multi-session tab switching for user-created sessions.

---

## 3. Architecture & Key Changes

### A. Subagent Event Bridging & Stdout Suppression (`src/agent/subagent-manager.ts` & `src/ui/tea/index.ts`)
- Reuse the existing `KernelEventBus` and `AgentLoop` event pipeline (`tool:before`, `tool:after`, `model:thinking:start/token/end`, `step:before`, `step:after`) with `isSubagent: true` and `sessionId`.
- In `src/agent/subagent-manager.ts` and `src/agent/agent-loop.ts`, suppress `CLI.render...` terminal printing when inside subagent context, preventing raw ANSI escape sequences and `\r` spinner codes from reaching `stdout` and `sendCaptured()`.
- In `src/ui/tea/models/root-model.ts`, update `ownerAppendEntry` to append structured `TranscriptEntry` objects directly to the subagent's cached `entries`.

### B. Filter Subagent Tabs from Top Strip & General Session Modal (`src/ui/tea/models/viewport-model.ts`)
- In `sessionStripSegments(state, width)`:
  Filter out tabs where `tab.subagent === true`.
  The top tab strip only renders human/kernel user sessions (`subagent !== true`), preserving clean horizontal space.
- In `sessionTabsView(state, width, height)` (`Ctrl+T` Sessions Modal):
  Filter out `tab.subagent === true` so human session management remains uncluttered.

### C. Statusline Indicator Lifecycle & Hit-Testing (`src/ui/tea/models/statusline-model.ts`)
- Detect subagents in `model.sessions.tabs`:
  - If any subagent has `busy === true`: render purple indicator `color(tokyoNight.purple, '● Subagent working')` (or `● Subagent working (N)` if multiple).
  - If all subagents have finished (`!anyBusy` and subagent count > 0): render green indicator `color(tokyoNight.green, '✓ Subagent (All done)')`.
- Register the indicator segment in the mouse hit-test map so clicking it emits an action to toggle the Subagent Selector Modal.

### D. Subagent Selector Modal (`src/ui/tea/models/subagent-modal.ts` & `root-model.ts`)
- Add a new modal state `subagents: { open: boolean; selected: number }` to `RootModel`.
- The modal renders in the center of the terminal:
  - Header: `color(tokyoNight.purple, 'SUBAGENTS') · Esc to close`
  - Lists each subagent:
    - Status marker: yellow `●` for working, green `✓` for completed, red `✖` for failed.
    - Title / Objective brief.
    - Metadata: step count, elapsed runtime, ID.
  - Controls: `Up`/`Down` arrows to navigate; `Enter` to open full transcript; `Esc` to close modal.
- When a subagent is selected:
  - Record `previousActiveSessionId: model.sessions.activeId`.
  - Set `model.sessions.activeId = selectedSubagentSessionId`.
  - Close the modal and set focus to `'viewport'`.

### E. Full-Screen View & Esc to Return (`src/ui/tea/models/root-model.ts`)
- When viewing a subagent tab (`model.sessions.tabs.find(t => t.id === model.sessions.activeId)?.subagent === true`):
  - Viewport renders the subagent's clean transcript with standard Tea styling.
  - The bottom composer input box is replaced by a static notice:
    `color(tokyoNight.muted, 'Viewing subagent transcript (read-only) · Press Esc to return to main session')`.
  - Keystrokes for scrolling (`Up`, `Down`, `PageUp`, `PageDown`, `Home`, `End`) scroll the transcript.
  - Pressing `Esc` immediately switches back to `previousActiveSessionId` (the user's main active session).

### F. Auto-Approve All for Subagent Sessions (`src/agent/subagent-manager.ts` & `src/security/permission-manager.ts`)
- In `src/agent/subagent-manager.ts` inside `launch()`:
  Configure the subagent's `PermissionManager` with `autoApproveAllSession: true`.
- In `PermissionManager.checkPermission`:
  - First, evaluate core hard safety policies: destructive system commands (`SYSTEM_DESTRUCTIVE_PATTERNS`), User Rule 2 branch push restrictions (`isBlockedGitPushToMain`), and filesystem escape violations. If violated, **hard-deny immediately** (`{ allowed: false, errorCode: '...' }`).
  - For standard workspace operations requiring approval (file writes, edits, builds, tests, scripts), if `isSubagent` or `autoApproveAllSession` is active, return `{ allowed: true, autoApproved: true }` immediately, without queuing an interactive approval request or halting background execution.

---

## 4. Verification & Testing Plan

1. **Unit Tests**:
   - `src/ui/tea/__tests__/tea-subagent-strip-filter.test.ts`: Verify `sessionTabStripView` and `sessionTabsView` omit subagent tabs.
   - `src/ui/tea/__tests__/tea-subagent-indicator.test.ts`: Test purple `"Subagent working"` during execution and transition to green `"Subagent (All done)"` upon completion.
   - `src/ui/tea/__tests__/tea-subagent-modal.test.ts`: Test opening subagent modal, navigating list, selecting subagent to view full-screen transcript, and returning to main session on `Esc`.
   - `src/agent/subagent-permission-auto.test.ts`: Verify mutating tools invoked by subagents run with auto-approval without prompting, while hard safety policies still reject destructive actions.
2. **Integration Verification**:
   - Spawn subagents in background, confirm no raw ANSI logs leak to stdout, top strip remains clean, bottom indicator transitions correctly, modal opens upon click, transcript displays structured `TranscriptEntry` items, and `Esc` returns to main session.
