# SDD ledger — plan: chat plan 2026-10-11 web-search self-host free (no plan file; source = conversation)

Ruling: work in place on develop (not a worktree) — prior uncommitted network-intent changes belong to this thread; worktree would strand them. Cost if wrong: mixed diff, mitigated by small commits.
Ruling: Task 2 (SearXNG settings.yml) is config — no unit test per TDD exceptions; verify with curl + docs update instead.
Pre-flight: no shared interfaces. Task 1 produces `preset` param consumed by no later task; Tasks 3-6 harden existing params. Single line: no cross-task conflicts.
