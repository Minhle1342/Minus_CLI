# Hybrid LSP runtime

Minus keeps its in-memory TypeScript Language Service and can additionally connect to external Language Server Protocol servers. External servers are optional, lazy-started, reused per project root, and never downloaded automatically.

Create `.minus/lsp.json` in the workspace:

```json
{
  "enabled": true,
  "diagnosticsWaitMs": 1500,
  "servers": {
    "typescript": {
      "command": ["typescript-language-server", "--stdio"],
      "extensions": [".ts", ".tsx", ".js", ".jsx"],
      "rootMarkers": ["package.json", "tsconfig.json"]
    },
    "pyright": {
      "command": ["pyright-langserver", "--stdio"],
      "extensions": [".py"],
      "rootMarkers": ["pyrightconfig.json", "pyproject.toml"]
    },
    "gopls": {
      "command": ["gopls"],
      "extensions": [".go"],
      "rootMarkers": ["go.work", "go.mod"]
    }
  }
}
```

The executable must already be installed. Minus invokes it directly with `shell: false`; it does not run package managers or installation scripts.

## Custom servers

Known language-server executable names are accepted. An arbitrary executable requires both `"trust": true` in that server entry and the environment variable `MINUS_LSP_TRUST_CUSTOM=1`. This two-part opt-in prevents a checked-out repository from silently using LSP configuration as arbitrary command execution.

## Agent behavior

- `get_diagnostics` merges external LSP diagnostics with the existing TypeScript in-memory diagnostics.
- `lsp_query` exposes hover, definition, references, document/workspace symbols, implementation and call hierarchy operations. Tool line/character values are 1-based.
- Successful write/replace/create/patch/move tool results include a bounded `lsp` feedback block when a matching server is configured.
- LSP startup or diagnostic failures are advisory and never reverse an otherwise successful file mutation. Use `lsp_query` with `operation: "status"` to inspect failures and configuration warnings.

