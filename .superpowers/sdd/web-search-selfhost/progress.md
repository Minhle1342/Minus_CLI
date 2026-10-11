# SDD ledger — plan: chat plan 2026-10-11 web-search self-host free (no plan file; source = conversation)

Ruling: work in place on develop (not a worktree) — prior uncommitted network-intent changes belong to this thread; worktree would strand them. Cost if wrong: mixed diff, mitigated by small commits.
Ruling: Task 2 (SearXNG settings.yml) is config — no unit test per TDD exceptions; verify with curl + docs update instead.
Pre-flight: no shared interfaces. Task 1 produces `preset` param consumed by no later task; Tasks 3-6 harden existing params. Single line: no cross-task conflicts.
Task 1: complete (commit 9e0f579, tests: web-search-preset 3/3 pass, RED watched 0/3 then GREEN 3/3)
Task 2: complete (commit 8ec7709, docs only; settings.yml already enables json + defaults; no live curl — Docker unavailable)
Task 3: verified-no-change (concise returns position/title/url/snippet only; caps max 20/default 8 already in code)
Task 4: verified-no-change (offset/hasMore/nextOffset + markdown/code_blocks/text live-checked via tsx)
Task 5: complete (commit c8c1d0c, tests: web-fetch-retry 1/1 RED→GREEN, github suite 5/5 still green)
Task 6: verified-no-change (injection flags fire: OVERRIDE_INSTRUCTION + SECRET_LEAK on live payload)
Final: self-review (no subagent reviewer tool for code-reviewer workflow in this harness). Diff across 4 commits: preset merge, docs line, 429 retryable, network-intent signal + gate pin. No auth widening (pin filtered by allowed), no new deps, no paid APIs. Full targeted suite 32/32 green.
