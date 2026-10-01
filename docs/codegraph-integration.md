# CodeGraph integration

CodeGraph (https://github.com/colbymchenry/codegraph) cung cấp semantic code graph local: 1 call trả source + call paths + blast radius.

## 1. OpenCode chuẩn (opencode.json)

File `opencode.json` ở root đã khai báo MCP server:

```json
{ "mcp": { "codegraph": { "type": "local", "command": ["codegraph", "serve", "--mcp"], "enabled": true } } }
```

Setup máy dev:

```bash
npm i -g @colbymchenry/codegraph
codegraph install --target=opencode --yes
cd <project> && codegraph init
```

Mở lại opencode để load MCP tool `codegraph_explore`.

## 2. MinusCLI native (không cần MCP)

- `src/search/codegraph-client.ts`: wrapper CLI (`explore/node/query/callers/callees/impact/status`), graceful khi chưa cài hoặc chưa `init`.
- `src/tools/codegraph-tools.ts`: 7 tools — `codegraph_explore`, `codegraph_node`, `codegraph_search`, `codegraph_callers`, `codegraph_callees`, `codegraph_impact`, `codegraph_status`.
- `src/kernel/plugins/codegraph-plugin.ts`: đăng ký tools + system-prompt policy (tắt bằng `MINUS_CODEGRAPH=0`).
- `src/index.ts`: `kernel.use(CodeGraphPlugin)` sau `SearchPlugin`.

Env:

| Var | Default | Ý nghĩa |
|---|---|---|
| `CODEGRAPH_BIN` | `codegraph` | Path tới binary |
| `CODEGRAPH_TIMEOUT_MS` | `60000` | Timeout mỗi lệnh |
| `MINUS_CODEGRAPH` | `1` | `0` để tắt plugin |
