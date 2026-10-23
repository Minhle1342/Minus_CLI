# Harness² Tool Guidance Optimization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Nâng cấp thành phần **Tool Guidance (tool_descriptions)** trong Harness² (arXiv:2610.14224) thành hệ thống hướng dẫn công cụ tiến hóa, hỗ trợ phân định theo pha (Plan vs Implement), sinh tự động catalog chuẩn cho 10+ core tools của MinusCLI, tích hợp vào chu trình Propose–Probe–Compose và đồng bộ 2 chiều với bundle storage.

**Architecture:** Mở rộng `Harness2RecursiveEngine` với bộ sinh `generateStandardToolGuidanceCatalog()` kết nối kiến thức từ `src/llm/sections/tools.ts`, cấu hình hướng dẫn công cụ theo từng biến thể ứng viên (`base`, `inv1`, `dom1`), đo lường độ tuân thủ công cụ trong probe evaluation, và đồng bộ đầy đủ các file markdown trong thư mục `tool_descriptions/`.

**Tech Stack:** TypeScript, Node.js Test Runner (`node:test`, `node:assert/strict`), File System Promises (`node:fs/promises`), GitNexus Graph-RAG.

**Spec:** [Harness²: Harnessing Agentic Reasoning via Recursive Scaffolding Optimization](https://arxiv.org/abs/2610.14224) - Mục 2.1 & 3.2: 8 Editable Scaffold Components (Tool Guidance & Descriptions).

## Global Constraints

- Runtime: Node.js ESM (sử dụng `node --import tsx --test` cho test suite).
- Tương thích ngược: Giữ nguyên interface `Harness2Bundle` hiện có; `toolGuidance` vẫn là `Record<string, string>`.
- Zero External Dependencies: Không cài thêm package mới; tận dụng stdlib `node:path`, `node:fs/promises`.
- Protocol GitNexus: Bắt buộc chạy `detect_changes({ scope: "staged" })` trước mỗi commit; không vi phạm cảnh báo High/Critical risk.

## Review Focus

1. **Fallback rỗng:** Khi `bundle.toolGuidance` rỗng hoặc thư mục `tool_descriptions/` không tồn tại, hệ thống không văng exception mà tự động fallback về catalog mặc định.
2. **Khóa công cụ theo Pha:** Trong chế độ `plan`, các công cụ thay đổi mã (`replace_text`, `apply_patch`, `write_file`) bắt buộc mang cảnh báo `[PHASE LOCK: MUTATION FORBIDDEN]`.
3. **Tiền điều kiện chặt chẽ:** Trong chế độ `implement`, các công cụ thay đổi mã phải hướng dẫn rõ chuỗi bắt buộc: `read_file` (xác thực dòng) -> `replace_text`/`apply_patch` -> `get_diagnostics` (kiểm tra sau sửa).
4. **An toàn tên file:** Chuẩn hóa tên file trong `tool_descriptions/*.md` loại bỏ ký tự lạ hoặc phần mở rộng lặp (`.md.md`).
5. **Dung hợp tối ưu (Composition):** Biến thể tổng hợp `agg1` kết hợp các chỉ dẫn tiền điều kiện của `inv1` với ngữ cảnh cú pháp/ngôn ngữ của `dom1`.

---

### Task 1: Core Tool Guidance Catalog & Phase-Aware Generator

**Files:**
- Modify: `src/agent/harness2-bridge.ts:30-45, 400-430`
- Modify: `src/agent/harness2-bridge.test.ts`

**Interfaces:**
- Consumes: `SECTION_PATCH_FORMAT_SPEC`, `TOOL_PLAYBOOK_PROMPTS` từ `src/llm/sections/tools.ts`
- Produces:
  - `Harness2RecursiveEngine.generateStandardToolGuidanceCatalog(options?: { phase?: 'plan' | 'implement' }): Record<string, string>`

- [x] **Step 1: Write failing test for standard tool guidance catalog generation**

Thêm test cases vào `src/agent/harness2-bridge.test.ts`:
```typescript
test('Harness2RecursiveEngine - Generate standard tool guidance catalog for core tools', () => {
  const engine = new Harness2RecursiveEngine();
  const catalog = engine.generateStandardToolGuidanceCatalog();

  // Must cover core tools
  const coreTools = ['read_file', 'replace_text', 'apply_patch', 'run_command', 'get_diagnostics', 'codegraph_explore', 'analyze_impact', 'create_plan', 'submit_solution', 'spawn_agent'];
  for (const tool of coreTools) {
    assert.ok(catalog[tool], `Catalog must contain guidance for ${tool}`);
    assert.ok(catalog[tool].length > 30, `Guidance for ${tool} must be informative`);
  }
});

test('Harness2RecursiveEngine - Generate phase-differentiated tool guidance', () => {
  const engine = new Harness2RecursiveEngine();
  
  const planCatalog = engine.generateStandardToolGuidanceCatalog({ phase: 'plan' });
  assert.ok(planCatalog.replace_text.includes('PHASE LOCK') || planCatalog.replace_text.includes('FORBIDDEN'));
  assert.ok(planCatalog.apply_patch.includes('PHASE LOCK') || planCatalog.apply_patch.includes('FORBIDDEN'));
  assert.ok(planCatalog.read_file.includes('primary') || planCatalog.read_file.includes('Survey') || planCatalog.read_file.includes('Inspect'));

  const implCatalog = engine.generateStandardToolGuidanceCatalog({ phase: 'implement' });
  assert.ok(implCatalog.replace_text.includes('read_file') || implCatalog.replace_text.includes('get_diagnostics'));
  assert.ok(implCatalog.apply_patch.includes('diff') || implCatalog.apply_patch.includes('patch'));
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/agent/harness2-bridge.test.ts`
Expected: FAIL with "engine.generateStandardToolGuidanceCatalog is not a function"

- [x] **Step 3: Implement `generateStandardToolGuidanceCatalog` in `Harness2RecursiveEngine`**

Trong `src/agent/harness2-bridge.ts`:
- Xây dựng catalog hoàn chỉnh bao gồm 10 core tools:
  - `read_file`: Hướng dẫn xem dòng chính xác, xử lý file nhị phân vs text, không đoán nội dung.
  - `replace_text`: Quy tắc unique substring match, truyền `expectedFileHash`, re-read khi hash conflict.
  - `apply_patch`: Hướng dẫn cú pháp 1-shot unified diff và fuzz tolerance.
  - `run_command`: Phân biệt lệnh nhanh (<5s) vs daemon/server (`WaitMsBeforeAsync`), cấm interactive prompts.
  - `get_diagnostics`: Gọi ngay lập tức sau mọi code edit để kiểm tra lỗi LSP.
  - `codegraph_explore`: Khảo sát kiến trúc, cấu trúc symbol và call paths trước khi lập kế hoạch.
  - `analyze_impact`: Đo lường blast radius và các upstream callers trước khi sửa signature.
  - `create_plan`: Cấu trúc DAG có `dependsOn`, 2-5 milestones nguyên tử.
  - `submit_solution`: Cổng nghiệm thu cuối cùng, đòi hỏi bằng chứng thực nghiệm và zero-mock.
  - `spawn_agent`: Phân bổ agent trinh sát chạy nền, chia sẻ context không xung đột.
- Khi `options?.phase === 'plan'`:
  - Thêm tiền tố `🔒 [PHASE LOCK: MUTATION FORBIDDEN IN PLAN MODE]` vào `replace_text`, `apply_patch`, `write_file`.
  - Tăng cường khuyến nghị cho `read_file`, `codegraph_explore`, `analyze_impact`, `create_plan`.
- Khi `options?.phase === 'implement'`:
  - Thêm hướng dẫn quy trình bắt buộc: `read_file` -> `replace_text`/`apply_patch` -> `get_diagnostics` -> `run_command` (test suite).

- [x] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/agent/harness2-bridge.test.ts`
Expected: PASS

- [x] **Step 5: Detect changes & Commit**

```bash
git add src/agent/harness2-bridge.ts src/agent/harness2-bridge.test.ts
git commit -m "feat(harness2): implement generateStandardToolGuidanceCatalog with phase-aware operational guidance"
```

---

### Task 2: Tool Guidance Evolution in Propose-Probe-Compose Engine

**Files:**
- Modify: `src/agent/harness2-bridge.ts:40-60, 80-220, 260-310`
- Modify: `src/agent/harness2-bridge.test.ts`

**Interfaces:**
- Consumes: `HarnessCandidate`, `generateStandardToolGuidanceCatalog`
- Produces:
  - `HarnessCandidate.toolGuidance?: Record<string, string>`
  - `Harness2RecursiveEngine.composeHarness()` tổng hợp `composedScaffold.toolGuidance`

- [x] **Step 1: Write failing test for candidate tool guidance variations and composition**

Thêm test cases vào `src/agent/harness2-bridge.test.ts`:
```typescript
test('Harness2RecursiveEngine - Propose candidates with specialized tool guidance', () => {
  const harness = new CognitiveHarness();
  const engine = new Harness2RecursiveEngine();
  const baseScaffold = harness.createScaffold({ request: 'Refactor auth controller', phase: 'implement' });

  const candidates = engine.proposeCandidates(baseScaffold, 'Refactor auth controller', { phase: 'implement' });
  const invCandidate = candidates.find(c => c.id === 'inv1');
  const domCandidate = candidates.find(c => c.id === 'dom1');

  assert.ok(invCandidate?.toolGuidance, 'Invariant candidate must specify specialized tool guidance');
  assert.ok(invCandidate.toolGuidance.replace_text.includes('Strict') || invCandidate.toolGuidance.replace_text.includes('prerequisite') || invCandidate.toolGuidance.replace_text.includes('read_file'));

  assert.ok(domCandidate?.toolGuidance, 'Domain candidate must specify specialized tool guidance');
});

test('Harness2RecursiveEngine - Compose refined tool guidance in composeHarness', () => {
  const harness = new CognitiveHarness();
  const engine = new Harness2RecursiveEngine();
  const baseScaffold = harness.createScaffold({ request: 'Fix null pointer in parser', phase: 'implement' });
  const candidates = engine.proposeCandidates(baseScaffold, 'Fix null pointer in parser', { phase: 'implement' });
  
  const evaluations: ProbeEvaluation[] = [
    { candidateId: 'base', score: 50, toolCallCount: 6, unproductiveLoopsDetected: 1, durationMs: 20, contrastNotes: [] },
    { candidateId: 'inv1', score: 85, toolCallCount: 4, unproductiveLoopsDetected: 0, durationMs: 15, contrastNotes: [] },
    { candidateId: 'dom1', score: 70, toolCallCount: 5, unproductiveLoopsDetected: 0, durationMs: 18, contrastNotes: [] },
  ];

  const result = engine.composeHarness(baseScaffold, candidates, evaluations);
  assert.strictEqual(result.selectedCandidateId, 'inv1');
  assert.ok(result.composedScaffold.toolGuidance);
  assert.ok(result.composedScaffold.toolGuidance.replace_text);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/agent/harness2-bridge.test.ts`
Expected: FAIL (assertion fails because `invCandidate.toolGuidance` is undefined)

- [x] **Step 3: Update `HarnessCandidate`, `proposeCandidates`, and `composeHarness`**

Trong `src/agent/harness2-bridge.ts`:
- Thêm trường `toolGuidance?: Record<string, string>` vào `HarnessCandidate` và mở rộng `CognitiveScaffold` với `toolGuidance?: Record<string, string>`.
- Trong `proposeCandidates()`:
  - Sinh catalog chuẩn cho `base`.
  - Đối với `inv1`: Thêm các ràng buộc bất biến nghiêm ngặt (Strict Invariant Gates) vào từng mô tả công cụ:
    - `replace_text`: "STRICT REQUIREMENT: MUST inspect lines via read_file immediately prior to mutation. MUST pass expectedFileHash. MUST immediately verify via get_diagnostics."
    - `run_command`: "STRICT REQUIREMENT: MUST NOT use sleep polling; use schedule. NEVER run destructive commands without user confirmation."
    - `submit_solution`: "STRICT REQUIREMENT: MUST verify exit code 0 on testCommand before submission. Fake mocks are strictly rejected."
  - Đối với `dom1`: Thêm chỉ dẫn chuyên biệt domain (TypeScript compile, patch format, Git isolation).
- Trong `composeHarness()`:
  - Lấy `toolGuidance` từ candidate có điểm số cao nhất (`bestCand.toolGuidance`).
  - Gộp bổ sung các chỉ dẫn kiểm tra biên vào `composedScaffold.toolGuidance`.

- [x] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/agent/harness2-bridge.test.ts`
Expected: PASS

- [x] **Step 5: Detect changes & Commit**

```bash
git add src/agent/harness2-bridge.ts src/agent/harness2-bridge.test.ts
git commit -m "feat(harness2): add tool guidance evolution to candidate proposals and composition"
```

---

### Task 3: Comprehensive Tool Guidance Bundle Export & Two-Way Sync

**Files:**
- Modify: `src/agent/harness2-bridge.ts:430-490`
- Modify: `src/agent/harness2-bridge.test.ts`

**Interfaces:**
- Consumes: `Harness2Bundle.toolGuidance`
- Produces:
  - Xuất 10+ file markdown riêng biệt trong `tool_descriptions/*.md`.
  - Nạp đầy đủ các mô tả công cụ từ `tool_descriptions/*.md` về `Harness2Bundle.toolGuidance`.

- [x] **Step 1: Write failing test for comprehensive bundle export and import of tool descriptions**

Thêm test cases vào `src/agent/harness2-bridge.test.ts`:
```typescript
test('Harness2RecursiveEngine - Export and import comprehensive tool descriptions', async () => {
  const engine = new Harness2RecursiveEngine();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness2-tools-bundle-test-'));
  try {
    const fullCatalog = engine.generateStandardToolGuidanceCatalog({ phase: 'implement' });
    const bundle: Harness2Bundle = {
      systemPrompt: 'MinusCLI Agent',
      guardrails: ['No mock'],
      memory: 'Project Memory',
      toolGuidance: fullCatalog,
      subagents: {},
      skills: [],
      scripts: {},
      plugins: {},
    };

    await engine.exportBundleToDirectory(bundle, tmpDir);

    const toolsDir = path.join(tmpDir, 'tool_descriptions');
    const exportedFiles = await fs.readdir(toolsDir);
    assert.ok(exportedFiles.length >= 10, `Expected at least 10 tool descriptions, found ${exportedFiles.length}`);
    assert.ok(exportedFiles.includes('read_file.md'));
    assert.ok(exportedFiles.includes('replace_text.md'));
    assert.ok(exportedFiles.includes('apply_patch.md'));
    assert.ok(exportedFiles.includes('get_diagnostics.md'));

    const imported = await engine.importBundleFromDirectory(tmpDir);
    assert.strictEqual(Object.keys(imported.toolGuidance).length, exportedFiles.length);
    assert.strictEqual(imported.toolGuidance.read_file, fullCatalog.read_file);
    assert.strictEqual(imported.toolGuidance.replace_text, fullCatalog.replace_text);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/agent/harness2-bridge.test.ts`
Expected: FAIL (assertion fails if export/import doesn't preserve all catalog tools)

- [x] **Step 3: Update `exportBundleToDirectory` and `importBundleFromDirectory`**

Trong `src/agent/harness2-bridge.ts`:
- Trong `exportBundleToDirectory()`:
  - Nếu `bundle.toolGuidance` rỗng, tự động lấy catalog mặc định từ `this.generateStandardToolGuidanceCatalog()`.
  - Ghi từng entry ra `tool_descriptions/<toolName>.md`.
  - Đảm bảo làm sạch tên file (chỉ giữ ký tự `[a-zA-Z0-9_-]`).
- Trong `importBundleFromDirectory()`:
  - Đọc toàn bộ file `.md` trong `tool_descriptions/`.
  - Trích xuất tên tool từ tên file (loại bỏ đuôi `.md`).
  - Gán vào `bundle.toolGuidance[toolName]`.
  - Nếu thư mục `tool_descriptions/` không tồn tại, fallback an toàn về `generateStandardToolGuidanceCatalog()`.

- [x] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/agent/harness2-bridge.test.ts`
Expected: PASS

- [x] **Step 5: Detect changes & Commit**

```bash
git add src/agent/harness2-bridge.ts src/agent/harness2-bridge.test.ts
git commit -m "feat(harness2): support multi-tool markdown persistence and two-way sync in bundle storage"
```

---

### Task 4: CLI Bridge & Propose-Probe-Compose Runner Integration

**Files:**
- Modify: `scripts/harness2-minus-bridge.ts`
- Modify: `scripts/run-propose-probe-compose.ts`

**Interfaces:**
- Consumes: `generateStandardToolGuidanceCatalog`, `HarnessCandidate.toolGuidance`
- Produces: CLI reporting on tool guidance catalog, candidate contrasts, and export sync

- [x] **Step 1: Update `scripts/harness2-minus-bridge.ts` to export full tool catalog**

Trong `scripts/harness2-minus-bridge.ts`:
- Thay thế 3 tool cũ bằng `engine.generateStandardToolGuidanceCatalog()`:
  ```typescript
  toolGuidance: engine.generateStandardToolGuidanceCatalog(),
  ```
- Cập nhật hiển thị chi tiết danh sách các công cụ được xuất và nạp.

- [x] **Step 2: Update `scripts/run-propose-probe-compose.ts` to display tool guidance contrast**

Trong `scripts/run-propose-probe-compose.ts`:
- Trong Step 1 (Propose): In tóm tắt số lượng công cụ có hướng dẫn và các quy tắc tool guidance nổi bật của từng ứng viên (`base`, `inv1`, `dom1`).
- Trong Step 3 (Compose): In danh sách các công cụ trong composed scaffold kèm chỉ dẫn trọng tâm.

- [x] **Step 3: Run Runner and Bridge Verification**

Run:
```bash
npx tsx scripts/harness2-minus-bridge.ts --export
npx tsx scripts/harness2-minus-bridge.ts --import
npx tsx scripts/run-propose-probe-compose.ts --task=task-bugfix-growth-rate --phase=both
```
Expected:
- Xuất thành công 10+ file `tool_descriptions/*.md`.
- Nạp thành công và báo cáo đủ 10+ tools.
- Runner hiển thị các tương phản về Tool Guidance giữa các candidate.

- [x] **Step 4: Detect changes & Commit**

```bash
git add scripts/harness2-minus-bridge.ts scripts/run-propose-probe-compose.ts
git commit -m "feat(harness2): integrate rich tool guidance into runner and minus-bridge CLI"
```

---

### Task 5: End-to-End Suite Verification & Plan Check-Off

**Files:**
- Modify: `docs/superpowers/plans/2026-10-23-harness2-tool-guidance-optimization.md`

**Interfaces:**
- Consumes: All implementations from Tasks 1-4
- Produces: 100% passing test suite and checked-off plan document

- [x] **Step 1: Run complete unit test suite**

Run: `node --import tsx --test src/agent/harness2-bridge.test.ts`
Expected: PASS (Tất cả unit tests từ Task 1 đến Task 4 đều đạt 100%)

- [x] **Step 2: Run complete project regression checks**

Run: `npm test` hoặc các test suites liên quan để đảm bảo không có side-effects.

- [x] **Step 3: Update plan checkboxes to `- [x]` and commit**

```bash
git add docs/superpowers/plans/2026-10-23-harness2-tool-guidance-optimization.md
git commit -m "chore(harness2): complete end-to-end verification of tool guidance optimization"
```
