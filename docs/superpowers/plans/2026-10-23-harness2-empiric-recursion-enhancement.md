# Harness² Empirical Recursion & Two-Way Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chuyển đổi Harness² Bridge từ cơ chế giả lập (mock probe) sang hệ thống đệ quy thực nghiệm (empirical recursion) có lưu trữ kinh nghiệm bền vững (persistent reflection library) và đồng bộ 2 chiều với Google Research Harness².

**Architecture:** Mở rộng `Harness2RecursiveEngine` với bộ nạp/lưu disk persistence, xây dựng `EmpiricalProbeRunner` đo lường số lần gọi tool và kết quả kiểm thử thực tế trong sandbox, tổng hợp đầy đủ 8 thành phần Scaffold (bao gồm tool guidance và skills), tích hợp kinh nghiệm đúc kết vào runtime `CognitiveHarness`.

**Tech Stack:** TypeScript (ES2022 / NodeNext), Node.js test runner (`node --test`), Node fs/promises, Google Research Harness² (arXiv:2610.14224).

**Spec:** Hệ thống Harness² của MinusCLI tích hợp kiến trúc đệ quy kép (Task-level & Harnessing-level recursion) theo bài báo Google Research arXiv:2610.14224 và thư mục `external/harness2`.

## Global Constraints

- Tuân thủ nghiêm ngặt quy tắc GitNexus: chạy `impact` trước khi chỉnh sửa bất kỳ symbol nào và phân tích `detect_changes` trước khi commit.
- Giữ nguyên tính tương thích ngược với các API hiện tại của `CognitiveHarness` và `Harness2RecursiveEngine`.
- Không phụ thuộc vào thư viện ngoài mới; sử dụng `node:fs/promises`, `node:path`, `node:child_process` chuẩn.
- Các bài kiểm thử phải chạy độc lập trên Windows và Linux thông qua `npm run test:harness2`.

## Review Focus

- File persistence I/O: Xử lý an toàn khi file `reflection_library.json` chưa tồn tại hoặc bị lỗi định dạng JSON (graceful fallback).
- Sandbox command timeout: Đảm bảo probe evaluation có strict timeout để tránh treo tiến trình khi lệnh kiểm thử lặp vô hạn.
- Negative gate deduplication: Tránh việc trùng lặp các quy tắc kiểm thử khi merge giữa nhiều ứng viên `inv1`, `dom1`.
- Round-trip bundle integrity: Đảm bảo việc export và import thư mục 8 thành phần giữ nguyên vẹn cấu trúc file của Harness².
- Concurrency & side effects: Tránh làm ô nhiễm workspace chính khi chạy các probe thử nghiệm.

---

### Task 1: Persistent Storage for Harnessing-Level Reflection Library

**Files:**
- Modify: `src/agent/harness2-bridge.ts:60-185`
- Modify: `src/agent/harness2-bridge.test.ts:1-70`

**Interfaces:**
- Consumes: `HarnessReflectionRecord` from `src/agent/harness2-bridge.ts`
- Produces:
  - `Harness2RecursiveEngine.saveLibraryToFile(filePath: string): Promise<void>`
  - `Harness2RecursiveEngine.loadLibraryFromFile(filePath: string): Promise<number>`
  - `Harness2RecursiveEngine.findRelevantLessons(taskBrief: string): string[]`

- [ ] **Step 1: Write failing tests for library persistence & relevance search**

Thêm các test cases vào `src/agent/harness2-bridge.test.ts`:
```typescript
test('Harness2RecursiveEngine - Save and load persistent reflection library', async () => {
  const engine = new Harness2RecursiveEngine();
  const tmpFile = path.join(os.tmpdir(), `harness2-lib-test-${Date.now()}.json`);
  try {
    engine.reflectAndAccumulate({
      taskId: 'task-1',
      taskBrief: 'TypeScript division by zero fix',
      adoptedHarnessId: 'dom1',
      outcome: 'ok',
      lessonsLearned: ['Enforce strict zero-denominator check'],
      suggestedGuardrails: ['NEVER divide without prior non-zero assertion'],
      timestamp: new Date().toISOString(),
    });
    await engine.saveLibraryToFile(tmpFile);
    
    const loadedEngine = new Harness2RecursiveEngine();
    const count = await loadedEngine.loadLibraryFromFile(tmpFile);
    assert.strictEqual(count, 1);
    assert.strictEqual(loadedEngine.getLibrary().length, 1);
    
    const lessons = loadedEngine.findRelevantLessons('division zero');
    assert.ok(lessons.length > 0);
  } finally {
    await fs.rm(tmpFile, { force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:harness2`
Expected: FAIL with "engine.saveLibraryToFile is not a function"

- [ ] **Step 3: Implement persistence methods in `src/agent/harness2-bridge.ts`**

Triển khai:
- `saveLibraryToFile(filePath: string)`: Ghi JSON có format đẹp ra đĩa, tạo thư mục cha nếu chưa có.
- `loadLibraryFromFile(filePath: string)`: Đọc và parse JSON, nạp vào `persistentLibrary`. Bỏ qua nếu file chưa tồn tại và trả về 0.
- `findRelevantLessons(taskBrief: string)`: So khớp từ khóa giữa `taskBrief` với `taskBrief` và `lessonsLearned` trong library để trả về các bài học liên quan nhất.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:harness2`
Expected: PASS (all tests pass)

- [ ] **Step 5: Impact & Graph change review and Commit**

```bash
git add src/agent/harness2-bridge.ts src/agent/harness2-bridge.test.ts
git commit -m "feat(harness2): add persistent reflection library storage and lesson retrieval"
```

---

### Task 2: Empirical Contrastive Probe Evaluator

**Files:**
- Modify: `src/agent/harness2-bridge.ts:40-150`
- Modify: `src/agent/harness2-bridge.test.ts`
- Modify: `scripts/run-propose-probe-compose.ts:35-80`

**Interfaces:**
- Consumes: `HarnessCandidate`, `ProbeEvaluation`
- Produces:
  - `Harness2RecursiveEngine.evaluateCandidateEmpirically(candidate: HarnessCandidate, context: { testCommand: string; cwd: string; timeoutMs?: number }): Promise<ProbeEvaluation>`

- [ ] **Step 1: Write failing tests for empirical probe evaluation**

Thêm test case vào `src/agent/harness2-bridge.test.ts`:
```typescript
test('Harness2RecursiveEngine - Evaluate candidate empirically with actual command execution', async () => {
  const engine = new Harness2RecursiveEngine();
  const candidate: HarnessCandidate = {
    id: 'test-cand',
    kind: 'invariant',
    description: 'Test invariant',
    scaffold: {
      category: 'code',
      negativeGate: ['NEVER mock data'],
      falsificationCriteria: 'test fails',
      executionTopology: ['Step 1'],
      actionBoundary: 'Boundary',
    },
  };

  const evalResult = await engine.evaluateCandidateEmpirically(candidate, {
    testCommand: 'node -e "process.exit(0)"',
    cwd: process.cwd(),
    timeoutMs: 5000,
  });

  assert.strictEqual(evalResult.candidateId, 'test-cand');
  assert.strictEqual(evalResult.testsPassed, true);
  assert.ok(evalResult.score > 70);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:harness2`
Expected: FAIL with "engine.evaluateCandidateEmpirically is not a function"

- [ ] **Step 3: Implement `evaluateCandidateEmpirically`**

Triển khai phương thức trong `Harness2RecursiveEngine`:
- Sử dụng `child_process.exec` kèm timeout.
- Tính điểm score dựa trên kết quả thực thi thực tế (pass/fail, duration ms, mức độ bao phủ của negative gates).
- Thay thế các số liệu hardcoded trong `scripts/run-propose-probe-compose.ts` bằng lệnh gọi `engine.evaluateCandidateEmpirically`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:harness2`
Expected: PASS

- [ ] **Step 5: Impact & Graph change review and Commit**

```bash
git add src/agent/harness2-bridge.ts src/agent/harness2-bridge.test.ts scripts/run-propose-probe-compose.ts
git commit -m "feat(harness2): implement empirical probe evaluation replacing mock numbers"
```

---

### Task 3: Full 8-Component Bundle Two-Way Synchronization

**Files:**
- Modify: `src/agent/harness2-bridge.ts:180-217`
- Modify: `src/agent/harness2-bridge.test.ts`
- Modify: `scripts/harness2-minus-bridge.ts`

**Interfaces:**
- Consumes: Directory path containing Harness² bundle
- Produces:
  - `Harness2RecursiveEngine.importBundleFromDirectory(inDir: string): Promise<Harness2Bundle>`

- [ ] **Step 1: Write failing test for bundle import**

Thêm test case vào `src/agent/harness2-bridge.test.ts`:
```typescript
test('Harness2RecursiveEngine - Import 8-component bundle from directory (Two-Way Sync)', async () => {
  const engine = new Harness2RecursiveEngine();
  const tmpDir = path.join(os.tmpdir(), `harness2-import-test-${Date.now()}`);
  try {
    const bundle: Harness2Bundle = {
      systemPrompt: 'Test system prompt',
      guardrails: ['Guardrail 1', 'Guardrail 2'],
      memory: 'Test memory',
      toolGuidance: { testTool: 'Guidance' },
      subagents: { scout: { role: 'Scout', instructions: 'Recon' } },
      skills: ['test-skill'],
      scripts: { test: 'npm test' },
      plugins: { testPlugin: true },
    };
    await engine.exportBundleToDirectory(bundle, tmpDir);
    
    const imported = await engine.importBundleFromDirectory(tmpDir);
    assert.strictEqual(imported.systemPrompt, bundle.systemPrompt);
    assert.strictEqual(imported.guardrails.length, 2);
    assert.strictEqual(imported.toolGuidance.testTool, 'Guidance');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:harness2`
Expected: FAIL with "engine.importBundleFromDirectory is not a function"

- [ ] **Step 3: Implement `importBundleFromDirectory`**

Triển khai trong `src/agent/harness2-bridge.ts`:
- Đọc `systemprompt.md`, `guardrails.md`, `LongTermMEMORY.md`.
- Đọc thư mục `tool_descriptions/*.md`, `sub_agents/*.json`, `skills/*.md`.
- Khôi phục thành đối tượng `Harness2Bundle` hoàn chỉnh.
- Thêm flag `--import` vào `scripts/harness2-minus-bridge.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:harness2`
Expected: PASS

- [ ] **Step 5: Impact & Graph change review and Commit**

```bash
git add src/agent/harness2-bridge.ts src/agent/harness2-bridge.test.ts scripts/harness2-minus-bridge.ts
git commit -m "feat(harness2): implement two-way bundle import and export synchronization"
```

---

### Task 4: Runtime CognitiveHarness Integration with Reflection Library

**Files:**
- Modify: `src/agent/cognitive-harness.ts:230-310`
- Modify: `src/agent/cognitive-harness.test.ts` (hoặc test tương ứng)
- Modify: `src/agent/harness2-bridge.ts`

**Interfaces:**
- Consumes: `Harness2RecursiveEngine.findRelevantLessons()`
- Produces: `CognitiveHarness.setHarness2Engine(engine: Harness2RecursiveEngine): void`

- [ ] **Step 1: Write failing test verifying lessons injection into CognitiveScaffold**

Thêm test case kiểm tra scaffold nạp guardrails từ persistent library:
```typescript
test('CognitiveHarness - Injects learned negative gates from Harness2 engine', () => {
  const engine = new Harness2RecursiveEngine();
  engine.reflectAndAccumulate({
    taskId: 'task-growth',
    taskBrief: 'Division by zero bug',
    adoptedHarnessId: 'dom1',
    outcome: 'ok',
    lessonsLearned: ['Always guard zero denominator'],
    suggestedGuardrails: ['NEVER divide by zero without prior check'],
    timestamp: new Date().toISOString(),
  });

  const harness = new CognitiveHarness();
  harness.setHarness2Engine(engine);
  const scaffold = harness.createScaffold({ request: 'Sửa lỗi division by zero' });

  assert.ok(scaffold.negativeGate.some(g => g.includes('NEVER divide by zero')));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:completion` hoặc test suite liên quan.
Expected: FAIL with "harness.setHarness2Engine is not a function"

- [ ] **Step 3: Implement engine injection in `CognitiveHarness`**

Trong `src/agent/cognitive-harness.ts`:
- Thêm property `private harness2Engine?: Harness2RecursiveEngine`.
- Trong `buildScaffold()`, nếu `harness2Engine` được thiết lập, truy vấn `findRelevantLessons(params.request)` và đưa các `suggestedGuardrails` vào `scaffold.negativeGate`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:harness2`
Expected: PASS

- [ ] **Step 5: Impact & Graph change review and Commit**

```bash
git add src/agent/cognitive-harness.ts src/agent/harness2-bridge.ts
git commit -m "feat(cognitive-harness): wire harness2 learned lessons into runtime cognitive scaffold"
```

---

### Task 5: End-to-End Cycle Verification and Documentation

**Files:**
- Modify: `scripts/run-propose-probe-compose.ts`
- Modify: `docs/superpowers/plans/2026-10-23-harness2-empiric-recursion-enhancement.md`

**Interfaces:**
- Consumes: All components from Tasks 1-4
- Produces: Fully verified test runs on benchmark tasks with empirical scoring

- [ ] **Step 1: Run complete harness test suite**

Run: `npm run test:harness2`
Expected: PASS (tất cả các unit test mới và cũ đều đạt 100%)

- [ ] **Step 2: Run bundle export and verify 8 components**

Run: `npm run harness:export`
Expected: Xuất thành công vào `external/harness2/runs/minus_harness`

- [ ] **Step 3: Run propose-probe-compose cycle with live evaluation**

Run: `npm run harness:cycle -- --task=task-bugfix-growth-rate`
Expected: Chu trình Propose-Probe-Compose chạy thành công với điểm số thực nghiệm thực tế thay vì mock cứng.

- [ ] **Step 4: Final commit**

```bash
git add scripts/run-propose-probe-compose.ts
git commit -m "chore(harness2): verify end-to-end empirical recursion cycle"
```
