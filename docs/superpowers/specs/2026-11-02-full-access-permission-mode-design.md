# Full Access Permission Mode — Design

Ngày: 2026-11-02 · Trạng thái: đã thực thi (chưa commit) — xem §14 cho các deviation · Cách dựng: **B — mode thứ năm + bảng gate tập trung**

## 1. Intent và why

MinusCLI hiện lúc nào cũng còn một cánh cửa chặn LLM: thẻ approval, lệnh bị phân loại
"phá hệ thống", ranh giới workspace, Docker isolation, tool bị ẩn theo phase. Với repo
mà user đã tin cậy tuyệt đối (machine cá nhân, sandbox rời, công việc nội bộ), những
cánh cửa này thành ma sát: agent phải dừng giữa chừng để xin, và user bấm "yes" theo
quán tính chứ không đọc.

User muốn một **chế độ full access**: đã bật ở project nào thì trên máy đó, agent chạy
lệnh và dùng tool không bị chặn, không bị hỏi. Đây là chế độ tự nguyện, bật bằng tay,
và vẫn còn bốn ngoại lệ cứng mà chính user yêu cầu giữ lại (§6).

## 2. Goals

- Một `PermissionMode` mới `'full_access'`, là mode thật (không phải preset suy ra),
  đi qua `effectiveMode()` và `/permissions` y như bốn mode cũ.
- Khi bật, 7 gate trong bảng §5 mở; agent không còn bị từ chối hay bị hỏi ở bất kỳ
  tool call nào.
- Bốn gate trong §6 vẫn đóng, và **không có đường nào** (kể cả approval, kể cả env
  var, kể cả subagent) mở được chúng khi full access đang bật.
- Trạng thái lưu vĩnh viễn theo project, mở lại project là vẫn bật, nhìn thấy được.
- Một nguồn duy nhất liệt kê gate nào mở/đóng — file gate — để log, `/permissions
  status` và test cùng đọc một bảng.

## 3. Non-goals

- Không làm per-tool / per-command granularity cho full access (chỉ on/off).
- Không xóa, không refactor các gate cũ; khi full access tắt, hành vi phải **giống hệt
  hôm nay**, từng dòng.
- Không đụng plan lock, không đụng `read_only`.
- Không đụng *cơ chế* của control-plane governance (`hashAllowedToolSet`, decisionId
  binding, ToolScope) — nó vẫn chạy như cũ, chỉ nhận một allowed-set lớn hơn khi gate 5
  mở. *Phần authorization theo phase bên trong* `ThisTurnToolGate.decide` là một gate
  (xem §5 dòng 5), không phải cơ chế.
- Không được đổi hành vi của các mode cũ một cách vô điều kiện: mọi nới lỏng phải nằm
  sau `isGateOpen`, kể cả việc đảo thứ tự trong `evaluateCommand` (§5 dòng 2).
- Không đổi cách secrets được ghi ra log/disk ở các module khác (dream, task logs).

## 4. Anti-goals

- Full access bí mật: user không nhìn thấy trạng thái đang bật → thất bại về UX/an toàn.
- Full access mở được push-main hoặc tắt được redaction output → đúng cái user cấm.
- Một gate mới thêm sau này âm thầm chặn khi full access bật vì nó không được khai
  báo ở bảng gate.
- State lệch: mode lưu một đằng, gate thực tế chạy một nẻo.

## 5. Bảng gate (mở khi `full_access`)

| # | Gate id | Chỗ chặn hôm nay | Mở bằng cách |
|---|---|---|---|
| 1 | `approval_prompt` | `checkPermission` permission-manager.ts:209-389 (auto_approve :286-291, ask_sensitive :294, session :303-313, headless deny :316-323, promptHandler :326-388) | Nhánh mode mới: trả `{allowed:true}` ngay sau `effectiveMode()`, không gọi promptHandler, không rơi vào headless deny |
| 2 | `host_system_risk` | `evaluateHostCommandPolicy` command-isolation-policy.ts:85-108 (gọi ở run-command.ts:1443); `SYSTEM_DESTRUCTIVE_PATTERNS` sandbox-policy.ts:380-388; subagent SYSTEM_RISK permission-manager.ts:256-263 | `evaluateHostCommandPolicy` trả allowed; trong `evaluateCommand`, pattern check (:380) bị skip **chỉ khi gate mở** — không đảo thứ tự vô điều kiện, vì :391 hiện đặt sau :380 và đảo hẳn sẽ đổi hành vi của `unrestricted` sẵn có (vi phạm §3); subagent branch bỏ qua SYSTEM_RISK khi gate mở |
| 3 | `workspace_boundary` | `workspace.resolveSafePath` workspace.ts:191-214 (native `rsResolveSafePath` + JS fallback, ~30 call sites); `isPathContained` sandbox-policy.ts:396 và :474-482; SECURITY_VIOLATION tool-runner.ts:655-669 | `resolveSafePath` consult override → trả `path.resolve(rootDir, targetPath)` không ném, bỏ qua cả native; sandbox containment bỏ qua; tool-runner không báo escape |
| 4 | `docker_isolation` | `requiresIsolatedExecution`/`mustBlockUnisolatedAutoExecution` command-isolation-policy.ts:66-82 → ISOLATED_SANDBOX_REQUIRED run-command.ts:1520-1536. **Substrate isolation** `IsolatedExecutionSubstrate.exec` isolated-substrate.ts:34/:53/:68 (`SandboxPolicyEngine('workspace-write')` + `sanitizeEnvironment`, dựng qua substrate-factory, không biết PermissionManager) | `mustBlockUnisolatedAutoExecution` trả false khi gate mở (đường `MINUS_ALLOW_HOST_FALLBACK` :78 đã tồn tại, giữ nguyên); **khi full access, lệnh chạy ở host, bỏ hẳn substrate** *(call của tôi)* — vì mở policy trong container vẫn không ghi được ngoài mount point, nên không giữ được lời hứa gate 3; substrate vẫn dùng bình thường khi mode khác |
| 5 | `phase_masking` | Ba site, không phải hai: (a) lọc schema agent-loop.ts:1830-1839; (b) `checkPhaseToolEffect` phase-tool-effects.ts:58 gọi ở tool-runner.ts:633 và agent-loop.ts:3580; (c) **`ThisTurnToolGate.decide` this-turn-tool-gate.ts:91-95** denial vô điều kiện của tool mutation trong phase `explore`/`plan` + `capabilityMatch/phaseMatch/riskMatch` (:105-121), mà kết quả `authorizedToolNames` dựng runtime ToolScope (agent-loop.ts:1750/:1956) và báo "not authorized in phase" (:4001) | Skip (a) và (b) khi gate mở; `ThisTurnToolGate.decide` nhận `GateReader` (qua `ThisTurnToolGateOptions` :58-63) và khi gate mở thì không đưa tool vào `denied` vì phase/reversibility. Bắt buộc: nếu chỉ skip (a)(b) thì ở `MINUS_TOOL_CONTROL_MODE=enforce` **và cả ở default `shadow`** (:1317), `write_file` vẫn bị ToolScope từ chối — gate 5 sẽ là gate giả. Cơ chế hash/decisionId/ToolScope giữ nguyên (§3) |
| 6 | `protected_files` | `workspace.isProtectedFile` workspace.ts:266-270, chặn ở write-file.ts:54, replace-text.ts:108, delete-file.ts:21, tool-runner.ts:681, mutation-transaction.ts:130/158/194/230, run-command.ts:1251 | Override trả false ("không file nào được bảo vệ") khi gate mở. Ghi chú: `isSensitiveFile`/`SENSITIVE_FILE_PATTERNS` sandbox-policy.ts:31-39/:364-367 là **dead code, không call site** — không phải gate, không sửa trong change này |
| 7 | `child_env_scrub` | `buildSafeChildEnv` env-scrub.ts:20-51 → run-command.ts:2116/:2160, task-manager.ts:109; `blockedKeys` trong `sanitizeEnvironment` sandbox-policy.ts:495-511 | Khi gate mở, env con là `process.env` merge `extra` (token host tới được `gh`/`aws`/`gcloud`); `sanitizeEnvironment` không lọc key |

## 6. Bốn gate giữ (non-bypassable)

| Gate id | Chỗ chặn | Vì sao giữ |
|---|---|---|
| `push_to_main` | `isBlockedGitPushToMain` run-command.ts:458-465, dùng ở :1539 và permission-manager.ts:249 | User quyết: ngoại lệ cuối cùng; branch chung của repo. Không mode, không approval, không env nào mở được — kể cả trong subagent |
| `output_redaction` | `redactSecretsFromText` env-scrub.ts:76, dùng ở run-command.ts:409-425, task-manager.ts:167-170 | Redaction không chặn hành động nào; nó chỉ ngăn token của user đi lên server LLM và nằm lại trong log. Gate 7 mở env cho process con nên redaction càng phải ở lại |
| `repo_hooks` | `evaluateCommandHooks` run-command.ts:1426-1438, đọc `.minus/hooks.json` | User quyết 2026-11-02: "full access không xóa quyền của nó". Rule deny/warn do chính user viết trong repo là ý chí deliberately đặt ra, không phải cánh cửa harness áp lên user |
| `git_policy` | `checkGitPolicyForShell` run-command.ts:1703 | Cùng họ với `push_to_main`: policy git-intent do repo khai báo |

Hệ quả: full access **không** đồng nghĩa "không gì chặn được". Nó là "mọi gate harness
áp lên user đều bỏ, trừ cái user tự viết ra và hai cái bảo vệ branch chung + secrets".

## 6b. Gate chức năng — giữ đóng, không phải gate quyền

Không mở, vì mở không làm agent "tự do" hơn mà chỉ làm nó thất bại muộn hơn:

- `evaluateCommandPreflight` command-preflight-guard.ts:242 — hai denial:
  `INTERACTIVE_COMMAND_PROHIBITED` (:271) và `GIT_CLONE_CURRENT_DIRECTORY_FORBIDDEN`
  (:330). Cái đầu là lệnh cần stdin mà harness không trả lời được; cái sau luôn fail ở
  git level. (call của tôi)

## 7. Module gate mới


`src/security/full-access-gates.ts`:

```ts
export type FullAccessGate =
  | 'approval_prompt' | 'host_system_risk' | 'workspace_boundary'
  | 'docker_isolation' | 'phase_masking' | 'protected_files' | 'child_env_scrub';

export const FULL_ACCESS_GATES: readonly FullAccessGate[];          // bảng §5
export const NON_BYPASSABLE_GATES =
  ['push_to_main', 'output_redaction', 'repo_hooks', 'git_policy'] as const;
export type GateReader = (gate: FullAccessGate) => boolean;          // default: luôn false

export function isGateOpen(gate: FullAccessGate, mode: PermissionMode): boolean;
export function gateReport(mode: PermissionMode): string;            // cho log + /permissions status
```

`isGateOpen` chỉ trả true khi `mode === 'full_access'`. Mọi site bypass trong codebase
gọi qua nó (hoặc qua `GateReader` được inject), nên `grep 'isGateOpen('` liệt kê được
toàn bộ bề mặt của chế độ.

### Threading mode tới các module thuần

`sandbox-policy.ts`, `command-isolation-policy.ts`, `env-scrub.ts`, `workspace.ts` là
module thuần, không biết `PermissionManager`. Quyết định (call của tôi):

- Thêm tham số cuối **optional** `gates?: GateReader` vào các hàm cửa
  (`evaluateHostCommandPolicy`, `mustBlockUnisolatedAutoExecution`,
  `SandboxPolicyEngine` constructor, `buildSafeChildEnv`), và
  `options.boundaryOverride?: () => boolean` cho `Workspace`.
- Mặc định undefined = **đóng** ⇒ toàn bộ test hiện có chạy y nguyên, không đổi hành vi.
- Kernel nối một lần: `permissions` cấp `effectiveMode()`, `isGateOpen(gate, mode)`
  được đọc **live** mỗi lần gọi, không cache ⇒ không có state second để lệch (§4).
- `run-command`/`tool-runner` lấy reader từ `ToolExecutionContext` (đã mang ctx,
  agent-loop.ts:3450/:3974); nếu ctx thiếu thì đóng.

## 8. Cách bật, persist, hiển thị

- `PermissionMode` (permission-manager.ts:11) += `'full_access'`.
- `effectiveMode()` (:120-127) **giữ nguyên precedence**: `planLock → 'read_only'` vẫn
  là dòng đầu. Full access chỉ có tác dụng khi plan lock không active. User đã chốt.
- `/permissions full_access` (index.ts:2843-2873) + `/permissions project
  full_access` (:2861) + string usage trong cli-ui.ts:137.
- Confirmation khi chuyển vào mode: user phải gõ lại đúng chuỗi `full_access`; từ chối
  thì không đổi mode. (call của tôi)
- Persist **theo project**, đúng đường đã có: `setProjectMode` + `saveSession
  ({ permissionMode })` (index.ts:2858-2862). Form global `/permissions full_access`
  (:2873) giữ nguyên tính *không persist* như hôm nay — không thêm hành vi mới.
- `hydrateProjectPermission` (index.ts:651-656) currently whitelists four literal mode
  strings; phải thêm `'full_access'`, nếu không mode bị âm thầm mất khi mở lại project
  (`setProjectMode(root, null)` ⇒ rơi về `effectiveMode()` cũ). Test bắt buộc: save →
  reload → vẫn full access.
- Chỉ báo thường trực: badge `FULL ACCESS` trên status bar TUI + `gateReport()` in ra
  lúc bật và trong `/permissions status`. (call của tôi)
- Subagent: kế thừa full access vì đọc cùng `effectiveMode()`; `push_to_main`
  (permission-manager.ts:249) vẫn chặn, SYSTEM_RISK (:256-263) theo gate 2.
- Headless/non-interactive: gate 1 mở nên không còn APPROVAL_REQUIRED deny; bốn gate
  giữ (§6) vẫn trả denial như cũ.

## 9. Constraint

- AGENTS.md: `impact` upstream trước khi sửa mỗi symbol (đặc biệt `resolveSafePath` —
  ~30 caller, `checkPermission`, và `ThisTurnToolGate.decide` — nó feeds toàn bộ tool
  surface của mọi turn, HIGH risk nhiều khả năng; warning phải báo user, không waive),
  `detect_changes {scope:"all"}` trước commit.
- Không commit nếu user không yêu cầu.
- Windows-first: `resolveSafePath` có đường native (Rust N-API) — override phải bypass
  được cả nhánh native (workspace.ts:192-207).
- Không được làm lộ secret: gate 7 mở env, redaction (§6) là lớp cuối.

## 10. Approaches đã cân nhắc

- **A — mỗi gate tự kiểm tra mode:** dễ đọc, không thêm trừu tượng, nhưng logic rải
  6-8 file và không chứng minh được đã phủ đủ gate; gate mới thêm sau này không ai
  nhắc phải xét full access.
- **B — mode + bảng gate tập trung *(chosen)*:** vẫn là mode thật, mọi site đi qua
  `isGateOpen`/`GateReader`; danh sách gate là một hằng số nên design doc, log,
  `/permissions status` và test đọc đúng một bảng. Trade-off: thêm một lớp gián tiếp
  (nhẹ) và phải thread reader vào module thuần (§7).
- **C — preset lật các công tắc sẵn có** (`auto_approve` + `SandboxPolicyEngine
  'unrestricted'` + `toolControlMode off` + `MINUS_ALLOW_HOST_FALLBACK`): diff nhỏ
  nhất, nhưng (i) `unrestricted` hiện vẫn không mở được SYSTEM_DESTRUCTIVE
  (sandbox-policy.ts:380 chạy trước :391) nên vẫn phải code mới, (ii) mode trở thành
  trạng thái suy ra, lệch ngay khi user chỉnh lẻ một công tắc. User chọn B.

## 11. Test plan

Unit (`src/security/full-access-gates.test.ts`):
- Bảng gate: `isGateOpen` chỉ true với `full_access`, false với 4 mode còn lại và với
  `full_access + planLock` (assert ở tầng `effectiveMode`).
- `NON_BYPASSABLE_GATES` rời khỏi `FULL_ACCESS_GATES`, và mỗi id có đúng một test.

Invariant (mở rộng `command-isolation-policy.test.ts`, `phase-tool-effects.test.ts`,
thêm `full-access-mode.regression.test.ts`):
- Với reader mở: `evaluateHostCommandPolicy('rm -rf /')` allowed; `evaluateCommand`
  không còn trả SYSTEM_RISK cho `format C:`; `mustBlockUnisolatedAutoExecution` false;
  `checkPhaseToolEffect(write_file, 'explore')` allowed.
- `workspace.resolveSafePath('../outside.txt')` với `boundaryOverride` → trả path absolute
  ngoài repo, không ném; không có override → vẫn ném (regression cho ~30 caller).
- `isProtectedFile` gate mở → `write_file` ghi được file đã push vào `protectedFiles`.
- `buildSafeChildEnv` gate mở → `GITHUB_TOKEN` có trong env con.
- **Bốn gate giữ:** với reader mở hoàn toàn, `git push origin main` vẫn
  `PUSH_TO_MAIN_PROHIBITED` (cả main path run-command.ts:1539 lẫn subagent
  permission-manager.ts:249); stdout có `ghp_...` vẫn bị mask trước khi vào result;
  một rule deny trong `.minus/hooks.json` vẫn chặn lệnh ở run-command.ts:1426;
  `checkGitPolicyForShell` (:1703) vẫn trả denial.
- Reader default (không inject) → từng assert trên đảo ngược, chứng minh mode cũ không đổi.

Test thêm sau builder check:
- `ThisTurnToolGate.decide` với gate 5 mở, phase `explore`: `write_file` không xuất hiện
  trong `deniedToolNames`, và `ToolScope` runtime (agent-loop.ts:1956) cho phép call —
  đây là test chứng minh gate 5 không phải gate giả.
- Gate 5 mở nhưng `toolControlMode=enforce` **và** `shadow`: cả hai phải cho `write_file`
  qua (default là shadow, agent-loop.ts:1317).
- `evaluateCommand` với gate 2 **đóng**: `unrestricted` vẫn bị `SYSTEM_DESTRUCTIVE_PATTERNS`
  chặn như hôm nay (chứng minh không đổi hành vi cũ — §3).
- Substrate: gate 4 mở ⇒ `run_command` chọn `executionTarget: 'host'`, không tạo
  `IsolatedExecutionSubstrate`.
- Persist: `saveSession({permissionMode:'full_access'})` → `hydrateProjectPermission`
  trả đúng `'full_access'` (không rơi về `null`).
- §6b: preflight vẫn deny `INTERACTIVE_COMMAND_PROHIBITED` khi full access bật.

Legacy/tea: `npm test`, `npm run test:legacy`, `npm run test:tea` (card permission +
badge mới), `npx tsc --noEmit` (bắt chỗ union `PermissionMode` thiếu, kể cả các cast
`as any` ở index.ts:2861/:2873).

## 12. what's left to the builder

- Tên file/định dạng `gateReport()`; chỗ in badge trong TUI; độ dài chuỗi confirmation.
- Có update `docs/SANDBOX_RUNTIMES.md`/`architecture` hay không — mặc định: thêm một
  mục ngắn cho full access.
- `isSensitiveFile` dead code: để nguyên (outside scope), chỉ ghi chú trong §5.

### Các quyết định tôi tự chốt (user nên soát khi đọc doc)

1. Gate 5 phủ cả `ThisTurnToolGate` (§5 dòng 5) — nếu không thì gate 5 rỗng ở default config.
2. Gate 4: full access ép chạy host, bỏ substrate (§5 dòng 4).
3. Gate 2: skip pattern check có điều kiện, không đảo thứ tự vô điều kiện (§3 + §5 dòng 2).
4. Subagent theo full access, trừ `push_to_main` (§8).
5. `buildSafeChildEnv` khi gate 7 mở vẫn giữ các biến hardening (`CI`,
   `GIT_TERMINAL_PROMPT`, `PAGER`, `FORCE_COLOR`), chỉ bỏ allowlist-đang-cắt — tức là
   thêm token host, không bỏ hardening.
6. Gate 1 mô phỏng cờ `permissionGranted` của `auto_approve` để không đổi downstream.
7. Preflight guards giữ đóng (§6b).

## 13. Definition of Done

Bảng §5 mở đủ 7 gate và được chứng minh bằng test; bốn gate §6 đóng, mỗi gate có một
test; `output_redaction` không vòng qua được bằng mode, approval hay env var nào;
plan lock vẫn thắng; `/permissions`
bật/tắt/persist chạy và có xác nhận + badge; toàn bộ test hiện tại xanh mà **không sửa
đổi assertion nào để cho pass**; impact + detect_changes đã chạy và báo cáo cho user.

## 14. Ghi chú sau khi thực thi (deviation so với §7)

1. **Gate 3/6 không dùng `options.boundaryOverride`.** `Workspace` nhận reader qua
   `setDefaultWorkspaceGates(reader)` (một lần lúc boot, closure live trên
   `effectiveMode()`) cộng `setGates(reader)` để ghi đè theo instance trong test. Lý do:
   §7 chỉ attach instance gốc, trong khi subagent worktree (`agent-loop.ts:6138`) và
   spec branch (`speculative-branch-manager.ts:48/:64`) dựng `new Workspace(...)` mới —
   attach theo instance sẽ để gate 3/6 âm thầm đóng ở đó, đúng cái anti-goal §4
   "state lệch" cấm. Hệ quả: `agent-loop.setWorkspace` không còn gọi `setGates` nữa.
2. **Gate 5 kiểm chứng ở ba site thật**, như §5 dòng 5 yêu cầu: `ThisTurnToolGate.decide`
   (nhận `GateReader` qua options), bộ lọc schema + `checkPhaseToolEffect` trong
   `agent-loop`, và `checkPhaseToolEffect` trong `ToolRunner.run`. Test dispatch-site dùng
   `new ToolRunner(registry, workspace, new PermissionManager(...))` để chứng minh
   `PHASE_TOOL_EFFECT_BLOCKED` biến mất khi mode bật và vẫn còn khi mode tắt.
3. **Gate 4 kiểm chứng end-to-end** bằng `createRunCommandTool(fakeDocker, undefined, pm)`
   với `getStatus().isIsolated = true`: mode cũ → `executionTarget 'auto'` + container
   `exec` được gọi; `full_access` → `'host'` và container không chạy lệnh nào. Không có
   test riêng cho `IsolatedExecutionSubstrate` vì factory của nó
   (`ExecutionSubstrateFactory.create`) không có call site nào trong `run_command` —
   đường isolation thật của run_command là Docker + `execution_target`.
4. `gatesFromPermissionManager` fail-closed khi nguồn không có `effectiveMode()` (các
   call site cũ truyền permission manager duck-type chỉ có `checkPermission`), chứ không
   ném — bắt được bởi test cũ trong `run-command-git-policy.test.ts`.
