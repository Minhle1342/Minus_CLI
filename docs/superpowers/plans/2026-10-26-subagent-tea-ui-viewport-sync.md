# Subagent Tea UI Viewport Sync & Non-Intrusive Orchestration UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a seamless, clean Tea UI experience for subagent orchestration: isolate subagent transcripts into structured Tea UI entries, hide subagent tabs from top strip and `Ctrl+T`, display a dynamic purple/green statusline indicator, provide a Subagent Selector Modal to inspect full-screen transcripts with `Esc` return, and auto-approve subagent session permissions without interactive prompts.

**Architecture:** 
1. Subagent execution suppresses raw stdout ANSI escape codes and streams structured events into `TranscriptEntry` records.
2. The Tea UI top session strip and general `Ctrl+T` modal filter out `tab.subagent === true`.
3. The bottom statusline dynamically renders `● Subagent working` (purple) when active, and `✓ Subagent (All done)` (green) when finished, supporting mouse click hit-testing.
4. A dedicated Subagent Selector Modal enables users to select any subagent to view its full transcript in full-screen mode, with `Esc` returning to the main session.
5. `PermissionManager` grants automatic session approval for standard operations in subagent context, while preserving core hard safety prohibitions.

**Tech Stack:** TypeScript, Node.js Test Runner (`node --test`), Tea UI (Bubbletea-style state machine in `src/ui/tea/`), ANSI styling via `tokyoNight` palette.

**Spec:** `docs/superpowers/specs/2026-10-26-subagent-tea-ui-viewport-sync-design.md`

## Global Constraints
- Do not break existing user session management or multi-tab kernel workflows.
- Core safety policies (User Rule 2: never push to main/master, system-destructive commands, workspace boundary escapes) MUST remain hard-denied regardless of auto-approval.
- Every task must be backed by automated tests using `node --import tsx --test <test-file>`.
- Preserved CRLF line endings on Windows.
- Pre-edit GitNexus impact checks and post-edit `detect_changes` gating.

## Review Focus
1. Concurrency: Multiple subagents running in parallel must not interleave or overwrite each other's transcripts.
2. Leak prevention: Raw stdout from subagent tools must never leak into the main Tea UI viewport.
3. State restoration: Pressing `Esc` in a subagent transcript view must restore the user's previous active session, scroll position, and composer state.
4. Hit-testing: Terminal mouse clicks on the statusline indicator must accurately trigger the subagent modal across variable window widths.
5. Autonomous completion: Subagents attempting file mutations or test executions must never hang indefinitely on interactive permission requests.

---

### Task 1: Auto-Approve All Permissions for Subagents & Safety Hard-Denials

**Files:**
- Modify: `src/security/permission-manager.ts`
- Modify: `src/agent/subagent-manager.ts`
- Test: `src/agent/subagent-permission-auto.test.ts`

**Steps:**
- [ ] Write failing test in `src/agent/subagent-permission-auto.test.ts` verifying that subagent permission requests for mutating tools auto-approve without prompts, while destructive system commands are hard-denied.
- [ ] Run test to verify failure.
- [ ] Update `src/security/permission-manager.ts` to check `isSubagent` / `autoApproveAllSession` after hard security checks.
- [ ] Update `src/agent/subagent-manager.ts` to pass `autoApproveAllSession: true` in `launch()`.
- [ ] Run test to verify passing.
- [ ] Commit changes: `git commit -m "feat(security): auto-approve subagent session permissions while preserving safety policy"`.

---

### Task 2: Subagent Stdout Leak Suppression & Clean Transcript Ingestion

**Files:**
- Modify: `src/ui/tea/index.ts`
- Modify: `src/agent/subagent-manager.ts`
- Modify: `src/ui/tea/models/root-model.ts`
- Test: `src/ui/tea/__tests__/tea-subagent-clean-transcript.test.ts`

**Steps:**
- [ ] Write failing test in `src/ui/tea/__tests__/tea-subagent-clean-transcript.test.ts` verifying that subagent raw ANSI/Ink stdout strings are suppressed, and kernel events generate structured `TranscriptEntry` items (`step`, `tool`, `thinking`, `answer`).
- [ ] Run test to verify failure.
- [ ] In `src/ui/tea/index.ts`, drop raw captured stdout during subagent execution in `sendCaptured()`.
- [ ] In `src/ui/tea/models/root-model.ts`, ensure `tool:before`, `tool:after`, `step`, and `model:thinking` for subagent sessions create structured `TranscriptEntry` in the subagent's `entries` array.
- [ ] Run test to verify passing.
- [ ] Commit changes: `git commit -m "feat(tea-ui): suppress raw subagent stdout and structure clean transcript entries"`.

---

### Task 3: Filter Subagent Tabs from Top Strip & General `Ctrl+T` Modal

**Files:**
- Modify: `src/ui/tea/models/viewport-model.ts`
- Test: `src/ui/tea/__tests__/tea-subagent-strip-filter.test.ts`

**Steps:**
- [ ] Write failing test in `src/ui/tea/__tests__/tea-subagent-strip-filter.test.ts` verifying that `sessionTabStripView` and `sessionTabsView` exclude tabs where `subagent === true`.
- [ ] Run test to verify failure.
- [ ] In `src/ui/tea/models/viewport-model.ts`, filter out `t.subagent === true` in `sessionStripSegments()` and `sessionTabsView()`.
- [ ] Run test to verify passing.
- [ ] Commit changes: `git commit -m "feat(tea-ui): filter subagent tabs from top session strip and general session modal"`.

---

### Task 4: Dynamic Statusline Indicator ("Subagent working" / "Subagent (All done)") & Hit-Testing

**Files:**
- Modify: `src/ui/tea/models/statusline-model.ts`
- Modify: `src/ui/tea/models/root-model.ts`
- Test: `src/ui/tea/__tests__/tea-subagent-indicator.test.ts`

**Steps:**
- [ ] Write failing test in `src/ui/tea/__tests__/tea-subagent-indicator.test.ts` verifying purple `● Subagent working` during execution, green `✓ Subagent (All done)` when finished, and mouse hit-testing.
- [ ] Run test to verify failure.
- [ ] In `src/ui/tea/models/statusline-model.ts`, detect subagents and render purple when active, green when all finished.
- [ ] In `src/ui/tea/models/root-model.ts`, handle click on the subagent indicator to emit `subagents` modal action.
- [ ] Run test to verify passing.
- [ ] Commit changes: `git commit -m "feat(tea-ui): add dynamic purple/green subagent statusline indicator with mouse hit-test"`.

---

### Task 5: Subagent Selector Modal & Full-Screen Transcript View with Esc Return

**Files:**
- Create: `src/ui/tea/models/subagent-modal.ts`
- Modify: `src/ui/tea/models/root-model.ts`
- Modify: `src/ui/tea/types.ts`
- Test: `src/ui/tea/__tests__/tea-subagent-modal.test.ts`

**Steps:**
- [ ] Write failing test in `src/ui/tea/__tests__/tea-subagent-modal.test.ts` verifying modal rendering, keyboard selection, switching to full-screen transcript view, replacing composer with read-only notice, and `Esc` returning to previous main session.
- [ ] Run test to verify failure.
- [ ] Create `src/ui/tea/models/subagent-modal.ts` with `subagentsModalView` rendering list of subagents with status markers, titles, and step counts.
- [ ] In `src/ui/tea/types.ts` and `src/ui/tea/models/root-model.ts`, add `subagents: { open: boolean; selected: number }` and handle navigation / full-screen switch / `Esc` return.
- [ ] In `src/ui/tea/models/root-model.ts`, when viewing a subagent tab, render read-only hint instead of composer and scroll on navigation keys.
- [ ] Run test to verify passing.
- [ ] Commit changes: `git commit -m "feat(tea-ui): implement subagent selector modal and full-screen transcript view with Esc return"`.

---

### Task 6: Full Integration & Regression Verification

**Files:**
- Test: All test suites in `src/ui/tea/__tests__/` and `src/agent/`

**Steps:**
- [ ] Run all Tea UI tests: `node --import tsx --test src/ui/tea/__tests__/*.test.ts`.
- [ ] Run all Subagent and orchestration tests: `node --import tsx --test src/tools/subagent-delegation.test.ts src/control/orchestration-phase-access.test.ts`.
- [ ] Run GitNexus change analysis: `detect_changes({scope: "all"})`.
- [ ] Complete goal verification and report results.
