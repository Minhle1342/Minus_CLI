# Design: `shell: "powershell"` opt-in cho `run_command`

- Date: 2026-10-25
- Status: awaiting approval
- Size: small

## Intent

`run_command` hiện chạy mọi lệnh trên Windows qua `cmd.exe` (Rust core
`Command::new("cmd.exe")`, Node fallback `exec` → `%ComSpec%`). Người dùng
viết cú pháp PowerShell (`& ".\script.ps1"`, pipeline, cmdlet) bị từ chối
hoặc bị preflight sửa sai. Thêm một tham số opt-in `shell: "powershell"` để
lệnh nào cần PowerShell thì chạy bằng PowerShell, còn lại giữ nguyên
`cmd.exe`.

## Goals

- Tham số mới `shell: "powershell"` trên tool `run_command`; mặc định không
  đổi hành vi hiện tại.
- Exit code của lệnh gốc được truyền đúng về `exitCode`/`success`/
  `commandOutcome`.
- Toàn bộ chốt policy hiện có (allowlist, Git policy, workspace escape,
  preflight, approval) vẫn đánh giá trên **lệnh người dùng nhập**, không
  phải lệnh đã bọc.
- Không phải build lại `minus_core.node`.

## Non-goals / Anti-goals

- Không đổi shell mặc định sang PowerShell.
- Không hỗ trợ `pwsh` (PowerShell 7) như một giá trị riêng — chỉ
  `powershell`.
- Không sửa Rust core, không sửa `SandboxOptions`, không sửa
  `local-substrate.ts`.
- Không thêm tham số nào khác (`-NoProfile`, encoding… không được expose).
- Không nới lỏng allowlist hay policy nào cho lệnh bọc.
- Không đụng tầng emulator (`cat`/`ls`/`sed`/`rm`/`rg`) — chúng vẫn chạy
  Node I/O bất kể `shell`.

## Constraints

- Windows: `powershell.exe` luôn có sẵn. Non-Windows: dùng `pwsh`, và nếu
  thiếu thì cơ chế `probeMissingBinary` sẵn có sẽ báo `DEV_BINARY_NOT_FOUND`
  với gợi ý cài đặt — không viết nhánh lỗi mới.
- Docker isolation (`execution_target: "auto"` khi sandbox isolated) image
  Linux không có PowerShell → bị chặn với thông báo rõ ràng.
- Pre-flight hiện *giả định* cmd.exe: `normalizeWindowsCommand` bọc `&`,
  đổi `which`→`where`, `ls`→`dir`. Ba phép đó **hại** PowerShell (`where`
  là alias của `Where-Object`, `dir /a` không hợp lệ, `&` là call operator
  cần giữ). Phải tắt khi `shell: "powershell"`.
- PowerShell 5.1 không hỗ trợ `&&`. Đây là giới hạn đã chấp nhận: lệnh `&&`
  vẫn chạy được nếu toán tử nằm trong lệnh con dạng `"a && b"` qua cmd, còn
  không thì người dùng tự tách. Ghi rõ trong description của tool.

## Approaches (đã cân nhắc)

1. **Bọc ở tầng `run_command` bằng `-EncodedCommand`** — được chọn.
   Một helper bọc chuỗi lệnh thành
   `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <base64 UTF-16LE>`.
   Base64 loại bỏ hoàn toàn vấn đề escape ngoặc kép/phép thay thế. Một điểm
   sửa duy nhất trước các site dispatch → host, local, background, fallback
   đều hưởng. Không đụng Rust, không build lại addon.
   *Trả:* mỗi lệnh tốn thêm ~200–500ms khởi động PowerShell; lệnh bọc dài
   hơn (không quan trọng vì chỉ truyền qua argv).
2. **Đẩy `shell` xuống `SandboxOptions` + Rust core** — bỏ. Phải sửa Rust
   và build lại addon, đụng `SandboxManager`/`DockerSandbox`/`local-substrate`
   cho cùng một tính năng opt-in; blast radius rộng gấp nhiều lần.
3. **Bọc bằng `-Command "..."` text thường** — bỏ. Vỡ ngay khi lệnh chứa
   ngoặc kép hoặc `$`.

## How it gets built

- **Schema**: thêm `shell` (`Type.STRING`, mô tả ngắn) vào
  `createRunCommandTool`. Chỉ chấp nhận `"powershell"`; giá trị khác →
  lỗi `INVALID_SHELL` (mẫu giống nhánh `INVALID_EXECUTION_TARGET`).
- **Helper**: `wrapPowerShellCommand(command)` trả về
  `<shell> -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <b64>`,
  với `<shell>` = `powershell` trên win32, `pwsh` ở nền tảng khác.
  Encoding: `Buffer.from(script, 'utf16le').toString('base64')` với
  `script = "$ProgressPreference='SilentlyContinue'\n<command>\nif ($LASTEXITCODE) { exit $LASTEXITCODE }"`.
  Tiền tố tắt progress stream — **đã xác minh thực nghiệm**: không có nó thì
  mỗi lệnh cmdlet cũng xả `#< CLIXML` + progress record vào stderr. Đuôi
  propagates exit code của lệnh native về process exit code của PowerShell;
  nếu `$LASTEXITCODE` null (lệnh cmdlet) thì thoát 0. Đã kiểm chứng 8 ca
  (cmdlet OK, native fail, `exit 5`, lỗi cmdlet) — exit code khớp cả 8.
- **Điểm dispatch**: khai báo
  `const dispatchCommand = shell === 'powershell' ? wrap(...) : effectiveCommand;`
  ngay sau chốt Git policy (trước khối auto-background), rồi dùng
  `dispatchCommand` ở **mọi** site spawn:
  `taskManager.startTask`, `hostSandbox.exec` (cả lần retry auto-provision),
  `sandboxManager.exec`, `exec()` fallback (cả lần retry).
  Mọi payload kết quả (`command`, `diagnoseCommandFailure`,
  `annotateCommandResult`, `finalizeCommandResult`) vẫn nhận
  `effectiveCommand` (lệnh gốc) để classification/allowlist/hiển thị không
  thay đổi.
- **Chặn Docker**: ngay sau khi tính `dispatchCommand`, nếu
  `shell === 'powershell'` và `isolatedTarget` → trả về
  `POWERSHELL_ISOLATION_UNSUPPORTED` (mẫu giống
  `BACKGROUND_ISOLATION_UNSUPPORTED`).
- **Preflight**: thêm `shell?: 'powershell'` vào
  `EvaluateCommandPreflightOptions`, truyền từ `run-command.ts`; trong
  `normalizeWindowsCommand` bỏ qua toàn bộ mục 1 (bóc `&`, `which`→`where`,
  `ls`→`dir`) khi option này bật. Mục 2 (bóc tách `$env:`/`set`/`export`)
  giữ nguyên vì nó tách biến ra session env và hoạt động với mọi shell.
- **Phân tích lệnh**: AST parser POSIX đọc `&` của PowerShell thành toán tử
  background → "Empty shell command segment". Khi `shell: "powershell"`,
  phân tích trên bản đã bỏ `&` **đầu dòng**, lệnh dispatch vẫn giữ nguyên.
  shortcut: `&` ở giữa chuỗi (`a ; & b`) chưa xử lý — upgrade: mode PowerShell
  cho `shell-ast-parser`.
- **Bỏ qua binary probe** khi `shell: "powershell"`: cmdlet (`Get-Command`,
  `Test-Path`…) không nằm trên PATH nên probe sẽ báo `DEV_BINARY_NOT_FOUND`
  sai; PowerShell tự trả "is not recognized" rõ ràng, và nó cũng là thứ khiến
  `stderr.includes('not recognized')` hoạt động sẵn.
- **Làm sạch CLIXML**: thêm `unwrapPowerShellCliXml` vào
  `sanitizeTerminalOutput` — PowerShell 5.1 serialize error stream của chính
  nó ra CLIXML khi stderr là pipe (`#< CLIXML` + `<Objs>`), unwrap các payload
  `<S S="Error">` và giải mã `_xHHHH_`. shortcut: unwrap theo regex cho chuỗi
  flat, không decode CLIXML thật; upgrade: parse XML nếu có record lồng nhau.
- **Description tool**: ghi rõ `shell: "powershell"` opt-in, PS 5.1 không
  có `&&`, và nó không đi qua emulator.

## Tests

File: `src/tools/run-command-powershell.test.ts` (7 test, 0 skip trên win32).

- `wrapPowerShellCommand`: prefix đầy đủ, base64 decode ngược ra prelude +
  lệnh + đuôi exit code, lệnh chứa `"`/`$`/`&` sống sót nguyên vẹn.
- `unwrapPowerShellCliXml`: bóc payload lỗi, giải mã `_x000D_`, bỏ khối
  progress-only, không đụng output thường.
- `run_command` từ chối giá trị shell lạ → `INVALID_SHELL`.
- `shell: "powershell"` + Docker isolation → `POWERSHELL_ISOLATION_UNSUPPORTED`
  (chặn trước cả allowlist, mock `exec` phải không bị gọi).
- `normalizeWindowsCommand`: giữ `& "..."` và `which` khi `shell: "powershell"`,
  vẫn bóc như cũ khi không truyền option.
- Chạy thật qua PowerShell: `Write-Output hi` → exit 0/`success`,
  `node -e "process.exit(4)"` → exit 4, và payload `command` vẫn là lệnh gốc.
- `& ".\hello.ps1"` trong workspace tạm → chạy được, stdout khớp (chính là
  ca khiến AST parser phải được né `&` đầu dòng).

Xung quanh: 73 test trong `src/tools/*.test.ts` (allowlist, preflight, git
policy, background safety, workspace sandbox, binary probe) đều xanh.
`npx tsc --noEmit` chỉ còn 3 lỗi pre-existing ở
`src/agent/harness2-bridge.test.ts` (`durationMs` không thuộc `ProbeEvaluation`)
— không thuộc thay đổi này.

## What's left to the builder

Đã xác minh xong: exit code truyền đúng qua 8 ca thật với PowerShell 5.1 trên
máy đích, `$ProgressPreference` diệt được progress CLIXML, và CLIXML lỗi đã
được unwrap ở sanitizer. Không còn việc treo.
