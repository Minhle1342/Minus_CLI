# Minus TEA terminal UI

The production CLI uses an in-tree TypeScript Model–Update–View runtime and
immutable declarative ANSI styles. It requires no React, Ink, or native renderer.
The old Ink implementation is a deprecated development fixture for existing tests.

```sh
npm run build
npm start                          # full screen on a capable TTY
npm start -- run "explain this repo" --workspace ./project
npm start -- --headless "fix the issue" --workspace ./project
printf 'explain this repo' | npm start
npm run test:tea
```

Non-TTY input/output and TERM=dumb select linear headless output. A prompt must
be supplied as an argument or stdin. Permission requests are denied in headless
mode; configure the existing permission policy explicitly when needed.

| Key | Action |
| --- | --- |
| Ctrl+X C | Compact the session through the existing context command |
| Ctrl+X E | Compose using VISUAL/EDITOR (Notepad on Windows, vi elsewhere) |
| Ctrl+X Q | Cancel active work, restore the terminal, save and quit |
| Ctrl+X B / D | Toggle sidebar / diff |
| Ctrl+P | Fuzzy command palette, arrows to select, Enter to execute |
| Tab | Switch between Plan and Implement; change only between tasks |
| Ctrl+Space | Accept slash command or file mention completion |
| Alt+Enter / Shift+Enter | Insert a newline (Shift+Enter needs terminal support) |
| PageUp / PageDown | Scroll transcript; output stays pinned while scrolled up |
| Ctrl+C / Esc | Cancel a running task; dismiss an active question |
| Ctrl+O | Collapse or expand thought/tool entries |

Plan mode applies read_only permissions and uses the same planning workflow as
`/plan`, including the harness `create_plan` tool. Returning to Implement
restores the previous permission policy. After reviewing the plan, switch to
Implement and run `/plan resume` to continue its first incomplete task.

The diff view supports unified/split rendering (S), hunk collapse (H), hunk
selection (left/right), and scrolling. Mouse reporting is optional and disabled
by default. Bracketed paste preserves multiline input without submitting it.

Program owns raw mode, alternate screen, signal handlers, subscriptions, and a
60 FPS coalesced frame scheduler. Reducers return effect descriptions; the input
port executes effects, captures legacy command output as messages, and restores
stdout/stderr and terminal state on exit. KernelEvents are bridged exhaustively.

Permission diffs open automatically. While answering a question, Ctrl+X D toggles
the diff and PageUp/PageDown review its content or the full request transcript.
The answer draft stays isolated; cancellation denies the request.
