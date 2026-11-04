# MinusCLI

A local, single-user AI coding agent for the terminal. Point it at a folder; it
reads, edits and runs commands through a small fixed tool set, with permission
modes, a sandbox, persistent sessions and an optional native Rust core.

## Requirements

- Node.js 22+
- One provider API key (Google Gemini by default)

## Setup

```bash
npm install
cp .env.example .env    # fill in at least GEMINI_API_KEY
npm run dev
```

`MODEL_NAME` selects the model. If the primary provider fails with a rate limit,
the 3-tier fallback router switches to the next configured provider.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the CLI/TUI from source |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled build |
| `npm test` | Run the test suite (`src/**/*.test.ts`) |
| `npm run test:tea` | TUI-specific tests |
| `npm run eval:mock` | Offline evaluation harness |

## Layout

| Path | Contents |
| --- | --- |
| `src/index.ts` | Startup, session bootstrap, main loop wiring |
| `src/agent/` | Agent loop, context compaction, phases, effect ledger |
| `src/tools/` | The 9 model tools and their registry |
| `src/security/` | Permission modes, env scrubbing, policy |
| `src/sandbox/` | Command policy and isolated execution |
| `src/session/` | Append-only JSONL session store and config |
| `src/memory/` | Long-term project memory and vector store |
| `src/ui/` | Ink/React TUI (see `src/ui/tea/README.md` for keys) |
| `crates/minus_core` | Optional Rust acceleration |

## Data

Everything is written under `.codingagent/` in the workspace: session event
logs, `session.json`, project memory, and background-task logs. Delete that
folder to reset the agent for a project.

## Privacy

Command output is scrubbed of secret-looking environment values before it is
shown or stored, and every provider call is made with your own API keys.
`web_fetch` refuses loopback/private addresses unless
`MINUS_ALLOW_PRIVATE_FETCH=1` is set.
