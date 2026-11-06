# GitNexus Engineering Plan

> Task: Render live build/test command output line-by-line (max 6 lines) in the run_command tool result entry in the TUI viewport, streaming from command start to completion via a new tool:stream kernel event.
> Evidence verified at commit d4798759558d81d0a234b8256eb3cd76ce7b1a8b; GitNexus index fresh (lastCommit == HEAD, indexed 2026-11-06).
> Evidence provenance schema 2; global dirty digest 0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd; cited-path manifest 8 sorted entries; exact generated plan path excluded.

## 1. Objective

Stream build/test command output from src/tools/run-command.ts into the TUI tool result entry, rendering up to 6 lines live as they arrive, updating the same entry from command start to completion. Uses a new tool:stream kernel event.

## 2–3. Current Behaviour & Architecture [verified]

run_command (createRunCommandTool, src/tools/run-command.ts:1414) runs finite commands synchronously and returns all stdout/stderr at once via finalizeCommandResult (line 413); no intermediate output reaches the TUI. Long-lived commands go to background tasks, viewed via manage_task — not in the tool result entry.

Tool results render once: toolResultEntry (src/ui/tea/models/tool-entry.ts:208) calls resultPreview (MAX_RESULT_LINES=5, MAX_RESULT_CHARS=2400) and visibleValue. entryLines (src/ui/tea/models/viewport-model.ts:535) caches rendered lines per entry in a WeakMap (cachedLines). There is no mechanism to update an existing tool entry incrementally.

Kernel events flow through KernelEventBus (src/kernel/kernel.ts:128). KernelTEAAdapter (src/ui/tea/kernel-bridge.ts:15) binds all events in KERNEL_EVENT_NAMES (line 3-10) and forwards them as { type: 'kernel', event, args } Msg. root-model.ts reduce() (line 369) handles tool:before/tool:after/tool:error/model:token but not tool:stream. KernelEvents interface (kernel.ts:44) has no tool:stream member; KERNEL_EVENT_NAMES has a compile-time completeness check (MissingEffects, line 11-13) so adding one requires adding the other.

## 4–5. Findings [graph + verified]

Primary symbols (source-verified): createRunCommandTool (run-command.ts:1414), toolResultEntry (tool-entry.ts:208), entryLines/viewportLines (viewport-model.ts:535/625), KernelEvents (kernel.ts:44), KernelTEAAdapter (kernel-bridge.ts:15), reduce kernel switch (root-model.ts:369).

Direct dependents (d=1) [graph]: mergedToolEntry (tool-entry.ts:191, 5 callers in viewport-model.ts + root-model.ts), toolResultEntry (5 callers), toolCallEntry (5 callers), entryLines (3 callers in viewport-model.ts), toolErrorEntry (2 callers in root-model.ts). run_command is NOT in CONCURRENT_READ_ONLY_TOOLS, so mergedToolEntry does not apply.

Related tests [graph]: src/ui/tea/__tests__/tea-tool-entries.test.ts (tool-entry), src/ui/tea/__tests__/tea-reducer.test.ts (kernel→TEA), src/ui/tea/__tests__/tea-table.test.ts + tea-markdown.test.ts (viewport).

PDG [not indexed]: skipped for this UI/event feature; no statement-level slice required.

## 6. Proposed Changes

1. src/kernel/kernel.ts — Add 'tool:stream': (toolName: string, line: string, lineIndex: number, isLast: boolean, ctx?: SessionEventContext) => void to KernelEvents interface [verified].
2. src/ui/tea/kernel-bridge.ts — Add 'tool:stream' to KERNEL_EVENT_NAMES array (line 3-10) [verified; required by MissingEffects compile check].
3. src/ui/tea/models/tool-entry.ts — Add streamingToolResultEntry(name, lines, status) rendering max 6 lines in film-strip style [new].
4. src/ui/tea/models/viewport-model.ts — In entryLines, detect streaming tool entry and render up to 6 lines without WeakMap cache invalidation issues [verified].
5. src/ui/tea/models/root-model.ts — Add 'tool:stream' case in reduce() kernel switch to mutate the live tool entry [verified].
6. src/tools/run-command.ts — Emit tool:stream per output line during command execution, before finalizeCommandResult [verified].

## 7. Implementation Sequence

- [x] Task 1: Add tool:stream to KernelEvents + KERNEL_EVENT_NAMES (kernel.ts, kernel-bridge.ts). Test: tea-reducer.test.ts type check.
- [x] Task 2: Handle 'tool:stream' kernel msg in root-model.ts reduce() (find/mutate live tool entry for toolName).
- [x] Task 3: Add streamingToolResultEntry to tool-entry.ts (max 6 lines, film strip).
- [x] Task 4: Render streaming entry in viewport-model.ts entryLines().
- [x] Task 5: Emit tool:stream from run_command per output line during command execution.
- [x] Task 6: Run existing test suite (npm test) and confirm no regressions.
- [ ] Commit each task separately.

## 8. Test Strategy

- New: src/ui/tea/__tests__/tea-tool-entries.test.ts — streamingToolResultEntry renders ≤6 lines, handles isLast badge.
- New: src/ui/tea/__tests__/tea-reducer.test.ts — 'tool:stream' kernel msg updates live entry.
- Existing: tea-table.test.ts, tea-markdown.test.ts — viewport rendering unchanged.
- Command: npm test (script carries pre-hooks). Verify exitCode 0.
- Edge cases: partial line (no trailing newline), >6 lines (drop oldest), command failure mid-stream ([FAIL] replaces live lines).

## 11. Implementation Context (mini-pack)

evidence_provenance: schema_version 2; head_commit d4798759558d81d0a234b8256eb3cd76ce7b1a8b; global_dirty_digest sha256:0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd

cited_path_manifest (8 entries, sorted):
- src/kernel/kernel.ts (regular, clean)
- src/tools/run-command.ts (regular, clean)
- src/ui/tea/__tests__/tea-reducer.test.ts (regular, clean)
- src/ui/tea/__tests__/tea-tool-entries.test.ts (regular, clean)
- src/ui/tea/kernel-bridge.ts (regular, clean)
- src/ui/tea/models/root-model.ts (regular, clean)
- src/ui/tea/models/tool-entry.ts (regular, clean)
- src/ui/tea/models/viewport-model.ts (regular, clean)

## 12. Assumptions and Open Questions

- Partial line without trailing newline: buffer until newline or render immediately? [assumed: buffer until newline]
- >6 lines: drop oldest (film strip) or keep latest 6? [assumed: drop oldest]
- Background task commands (dev server/watcher): stream or remain task-managed? [assumed: stream for finite commands only]
- run_command needs access to kernel.events — thread via ToolExecutionContext or closure? [assumed: context]
- Plan written directly to repo (not via write-plan helper): evidence-provenance write-plan requires Linux /proc/self/fd or macOS O_DIRECTORY/O_NOFOLLOW; win32 offers neither, so direct write used. evidence_provenance data above was produced by the snapshot command (schema 2).

## 13. Definition of Done

- Build/test command output streams line-by-line into tool result entry (max 6 lines).
- Same entry updates from command start to completion; final [OK]/[FAIL] badge on completion.
- tool:stream is type-safe (KernelEvents + KERNEL_EVENT_NAMES in sync; MissingEffects check passes).
- Existing tests pass; no assertions modified to bypass failures.
