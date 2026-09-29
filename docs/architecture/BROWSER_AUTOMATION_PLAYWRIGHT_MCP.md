# Browser Automation via microsoft/playwright-mcp

LLM điều khiển browser ngoài codebase qua MCP stdio (accessibility tree, không cần vision).

## Luồng chuẩn (Playbook H_BROWSER)

```text
browser_navigate(url) -> browser_snapshot -> browser_click/type(ref) -> browser_wait -> browser_snapshot -> browser_close
```

## Files

| File | Vai trò |
|---|---|
| `src/mcp/mcp-client.ts` | JSON-RPC stdio client tối thiểu (initialize/tools-list/tools-call) |
| `src/mcp/mcp-manager.ts` | Lifecycle + guardrails: `--isolated --headless`, URL allowlist, idle-timeout, mock mode |
| `src/tools/browser-tools.ts` | 7 tools: navigate/snapshot/click/type/wait/screenshot/close |
| `src/tools/registry.ts:attachBrowserManager` | Đăng ký tools |
| `src/kernel/kernel.ts:browserMcp` | Khởi tạo `new McpManager()` mặc định |
| `src/security/permission-manager.ts` | `browser_navigate/snapshot/wait/screenshot/close`=MEDIUM, `click/type`=HIGH |
| `src/tools/tool-retriever.ts` | category `browser`, prune khi query không liên quan web/browser |
| `src/agent/tool-synergy-advisor.ts` | Playbook `H_BROWSER` |
| `deploy/sandbox/Dockerfile.playwright` | Image `mcr.microsoft.com/playwright` + `@playwright/mcp` pinned |

## Env (.env)

```env
PLAYWRIGHT_MCP_HEADLESS=1
PLAYWRIGHT_MCP_ISOLATED=1
PLAYWRIGHT_MCP_OUTPUT_DIR=scratch/browser
PLAYWRIGHT_MCP_ALLOWED_ORIGINS=https://example.com
PLAYWRIGHT_MCP_BLOCKED_ORIGINS=
PLAYWRIGHT_MCP_MOCK=1  # chỉ cho unit test, không spawn npx
```

## Test

```bash
node --import tsx --test src/tools/browser-tools.test.ts src/mcp/mcp-launch.test.ts
PLAYWRIGHT_MCP_MOCK=1 node --import tsx --test src/tools/browser-tools.test.ts
```

## Khắc phục spawn EINVAL

Thứ tự launch (`resolveServerLaunch` trong `src/mcp/mcp-manager.ts`):

1. `PLAYWRIGHT_MCP_COMMAND` (override; trỏ npx cũng được — code tự ghép spec pinned) → 2. local `node_modules/@playwright/mcp` qua `node` (không shell, không npx, offline) → 3. npx fallback với spec pinned `@playwright/mcp@0.0.25` (`shell:true` trên win32 vì Node ném EINVAL khi spawn `.cmd` với `shell:false`).
2. Điều kiện tiên quyết: `npm install` + `npx playwright install chromium` (chromium đã có trong `%USERPROFILE%\AppData\Local\ms-playwright`).
3. Lưu ý bản pinned `0.0.25` (khác README upstream mới nhất): không có flag `--timeout-action/--timeout-navigation` (timeout nằm ở client), viewport dạng `width,height` (`1280,720`), method là `browser_wait_for` / `browser_take_screenshot` (tool chuẩn `browser_wait`/`browser_screenshot` tự ánh xạ). Không thêm flag mới nếu chưa bump spec pinned.
4. Lưu ý sandbox: MCP server spawn trên host Node, không phải trong Docker sandbox; image `minus-playwright` chỉ dùng khi chạy agent trong container có sẵn browser.

## An toàn

1. Chỉ http(s); `file://`, `data:`, `javascript:` bị chặn tại `McpManager.checkUrlAllowed` trước khi tới browser.
2. Snapshot bọc `<!-- UNTRUSTED BROWSER CONTENT -->` để prompt phân biệt dữ liệu web.
3. Profile ephemeral (`--isolated`), output vào `scratch/browser`, `browser_close` cuối flow.
4. Pin `@playwright/mcp` trong `package.json`, không dùng `@latest` trôi version ở production.
