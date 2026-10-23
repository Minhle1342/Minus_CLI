# Harness² Plan & Implement System Prompt Optimization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nâng cấp Harness² Bridge để tối ưu hóa chuyên sâu System Prompt và Cognitive Scaffolding riêng biệt cho 2 chế độ cốt lõi: **Plan Mode** (phân rã kiến trúc, khóa mutation, đánh giá blast radius) và **Implement Mode** (TDD, reproduction test, sửa đổi nguyên tử, kiểm thử hồi quy thực nghiệm).

**Architecture:** Mở rộng `Harness2Bundle` với `systemPromptPlan` và `systemPromptImplement`, cập nhật `proposeCandidates()` để sinh các biến thể Scaffold chuyên biệt theo phase ('plan' vs 'implement'), xây dựng `generatePhaseSystemPrompt()` cầu nối với `phases.ts`, và nâng cấp runner để thăm dò (probe) độc lập cả 2 chế độ.

**Tech Stack:** TypeScript (ES2022 / NodeNext), Node.js test runner (`node --test`), Node fs/promises, Google Research Harness² (arXiv:2610.14224).

**Spec:** Hệ thống Scaffolding 8 thành phần của Harness² cho MinusCLI, tích hợp trực tiếp với bộ phân loại pha `TaskPhase` ('plan' | 'implement') và module `src/llm/sections/phases.ts`.

## Global Constraints

- Tuân thủ nghiêm ngặt quy tắc GitNexus: chạy `impact` trước khi sửa đổi symbol và kiểm tra `detect_changes` trước mỗi commit.
- Bảo đảm tính tương thích ngược 100%: nếu không chỉ định phase, `proposeCandidates()` và `Harness2Bundle` vẫn hoạt động với fallback mặc định.
- Không phát sinh dependency bên ngoài; tái sử dụng `node:fs/promises`, `node:path`, `node:child_process`.
- Các bài kiểm thử phải vượt qua 100% với `npm run test:harness2`.

## Review Focus

- **Plan mutation leakage**: Đảm bảo system prompt và guardrails của Plan mode triệt tiêu 100% nguy cơ gọi nhầm mutation tools (`replace_text`, `apply_patch`, `write_file`).
- **Implement blind-fix prevention**: Đảm bảo system prompt của Implement mode bắt buộc kiểm tra dòng code thực tế và viết reproduction test trước khi chỉnh sửa.
- **Bundle backward compatibility**: Đảm bảo khi file `systemprompt_plan.md` hoặc `systemprompt_implement.md` chưa tồn tại, hệ thống tự động fallback về `systemprompt.md`.
- **Diagnostic loop resilience**: Đảm bảo guidance của Implement mode tích hợp bước chạy `get_diagnostics` sau mỗi lần patch để tránh tích tụ lỗi syntax/types.
- **Task transition coherence**: Đảm bảo plan mode có chỉ dẫn kết thúc bằng `create_plan` và sẵn sàng gọi `request_phase_transition` sang implement mode.

---

### Task 1: Phase-Aware Candidate Generation in Harness2RecursiveEngine

**Files:**
- Modify: `src/agent/harness2-bridge.ts:70-135`
- Modify: `src/agent/harness2-bridge.test.ts`

**Interfaces:**
- Consumes: `CognitiveScaffold`, `TaskPhase` ('plan' | 'implement')
- Produces:
  - `Harness2RecursiveEngine.proposeCandidates(baseScaffold: CognitiveScaffold, taskBrief: string, options?: { phase?: 'plan' | 'implement' }): HarnessCandidate[]`

- [ ] **Step 1: Write failing tests for phase-aware candidate generation**

Thêm test cases vào `src/agent/harness2-bridge.test.ts`:
```typescript
test('Harness2RecursiveEngine - Propose specialized candidates for Plan mode', () => {
  const harness = new CognitiveHarness();
  const engine = new Harness2RecursiveEngine();

  const planScaffold = harness.createScaffold({
    request: 'Thiết kế kiến trúc hệ thống cache phân tán',
    phase: 'plan',
  });

  const candidates = engine.proposeCandidates(
    planScaffold,
    'Thiết kế kiến trúc hệ thống cache phân tán',
    { phase: 'plan' }
  );

  assert.strictEqual(candidates.length, 3);
  const invCandidate = candidates.find(c => c.id === 'inv1');
  assert.ok(invCandidate);
  // Invariant candidate for Plan mode must strictly prohibit code edits and require impact analysis
  assert.ok(invCandidate.scaffold.negativeGate.some(g => g.includes('PHASE LOCK: PLAN') || g.includes('NEVER attempt code mutations')));
  assert.ok(invCandidate.scaffold.executionTopology.some(s => s.includes('Architectural') || s.includes('Inspection')));
});

test('Harness2RecursiveEngine - Propose specialized candidates for Implement mode', () => {
  const harness = new CognitiveHarness();
  const engine = new Harness2RecursiveEngine();

  const implementScaffold = harness.createScaffold({
    request: 'Sửa lỗi deadlock trong transaction pool',
    phase: 'implement',
  });

  const candidates = engine.proposeCandidates(
    implementScaffold,
    'Sửa lỗi deadlock trong transaction pool',
    { phase: 'implement' }
  );

  const invCandidate = candidates.find(c => c.id === 'inv1');
  assert.ok(invCandidate);
  // Invariant candidate for Implement mode must enforce reproduction and zero-mock verification
  assert.ok(invCandidate.scaffold.negativeGate.some(g => g.includes('reproduction test') || g.includes('mock test data')));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:harness2`
Expected: FAIL (assertion fails because candidate gates lack specialized phase-differentiated rules)

- [ ] **Step 3: Implement phase differentiation in `proposeCandidates`**

Cập nhật hàm `proposeCandidates`:
- Đọc `options?.phase || baseScaffold.phase || 'implement'`.
- Nếu `phase === 'plan'`:
  - `inv1`: Tăng cường các quy tắc khóa chặt mutation (`🔒 [PHASE LOCK: PLAN] Code editing is strictly prohibited`), bắt buộc phân tích call graph (`codegraph_explore`/`analyze_impact`), cấm gọi `submit_solution` hoặc `update_plan_task` sớm.
  - `dom1`: Thêm chỉ dẫn phân tách subtasks theo cấu trúc DAG có `dependsOn` rõ ràng.
- Nếu `phase === 'implement'`:
  - `inv1`: Ép buộc reproduction test trước khi sửa, kiểm tra diagnostics (`get_diagnostics`) sau khi sửa, cấm giả lập kết quả.
  - `dom1`: Tối ưu hóa sửa đổi atomic và kiểm tra biên dữ liệu đặc thù.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:harness2`
Expected: PASS

- [ ] **Step 5: Impact & Graph change review and Commit**

```bash
git add src/agent/harness2-bridge.ts src/agent/harness2-bridge.test.ts
git commit -m "feat(harness2): add phase-aware candidate proposal for plan and implement modes"
```

---

### Task 2: Phase-Differentiated System Prompts in Harness2Bundle

**Files:**
- Modify: `src/agent/harness2-bridge.ts:20-35, 330-410`
- Modify: `src/agent/harness2-bridge.test.ts`
- Modify: `scripts/harness2-minus-bridge.ts`

**Interfaces:**
- Consumes: `Harness2Bundle`
- Produces:
  - `Harness2Bundle.systemPromptPlan?: string`
  - `Harness2Bundle.systemPromptImplement?: string`
  - Export/Import hỗ trợ `systemprompt_plan.md` và `systemprompt_implement.md`

- [ ] **Step 1: Write failing test for phase-differentiated bundle export and import**

Thêm test case vào `src/agent/harness2-bridge.test.ts`:
```typescript
test('Harness2RecursiveEngine - Export and import bundle with phase-specific system prompts', async () => {
  const engine = new Harness2RecursiveEngine();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness2-phase-prompt-test-'));
  try {
    const bundle: Harness2Bundle = {
      systemPrompt: 'Generic system prompt fallback',
      systemPromptPlan: 'Dedicated Plan Mode Prompt: Architectural survey and DAG decomposition.',
      systemPromptImplement: 'Dedicated Implement Mode Prompt: Surgical mutation and empirical verification.',
      guardrails: ['No mocking'],
      memory: 'Project Memory',
      toolGuidance: {},
      subagents: {},
      skills: [],
      scripts: {},
      plugins: {},
    };

    await engine.exportBundleToDirectory(bundle, tmpDir);

    const planPromptExists = await fs.stat(path.join(tmpDir, 'systemprompt_plan.md')).then(() => true).catch(() => false);
    const implPromptExists = await fs.stat(path.join(tmpDir, 'systemprompt_implement.md')).then(() => true).catch(() => false);
    assert.strictEqual(planPromptExists, true, 'systemprompt_plan.md should exist');
    assert.strictEqual(implPromptExists, true, 'systemprompt_implement.md should exist');

    const imported = await engine.importBundleFromDirectory(tmpDir);
    assert.strictEqual(imported.systemPromptPlan, bundle.systemPromptPlan);
    assert.strictEqual(imported.systemPromptImplement, bundle.systemPromptImplement);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:harness2`
Expected: FAIL ("systemprompt_plan.md should exist" assertion fails)

- [ ] **Step 3: Implement phase system prompt support in export and import**

Trong `src/agent/harness2-bridge.ts`:
- Mở rộng interface `Harness2Bundle`:
  ```typescript
  systemPromptPlan?: string;
  systemPromptImplement?: string;
  ```
- Trong `exportBundleToDirectory()`:
  - Nếu có `systemPromptPlan`, ghi ra `systemprompt_plan.md`.
  - Nếu có `systemPromptImplement`, ghi ra `systemprompt_implement.md`.
  - Luôn ghi `systemprompt.md` làm fallback tổng thể.
- Trong `importBundleFromDirectory()`:
  - Đọc `systemprompt_plan.md` nếu có.
  - Đọc `systemprompt_implement.md` nếu có.
- Cập nhật `scripts/harness2-minus-bridge.ts` để hiển thị thống kê cả 2 prompt khi export/import.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:harness2`
Expected: PASS

- [ ] **Step 5: Impact & Graph change review and Commit**

```bash
git add src/agent/harness2-bridge.ts src/agent/harness2-bridge.test.ts scripts/harness2-minus-bridge.ts
git commit -m "feat(harness2): support phase-differentiated system prompts in bundle storage"
```

---

### Task 3: Dynamic Phase System Prompt Assembler & Guidance Bridge

**Files:**
- Modify: `src/agent/harness2-bridge.ts`
- Modify: `src/agent/harness2-bridge.test.ts`

**Interfaces:**
- Consumes: `SECTION_PHASE_PLAN_GUIDANCE`, `SECTION_PHASE_IMPLEMENT_GUIDANCE` from `src/llm/sections/phases.ts`
- Produces:
  - `Harness2RecursiveEngine.generatePhaseSystemPrompt(phase: 'plan' | 'implement', customDirectives?: string[]): string`

- [ ] **Step 1: Write failing test for phase system prompt generation**

Thêm test case vào `src/agent/harness2-bridge.test.ts`:
```typescript
test('Harness2RecursiveEngine - Generate structured system prompt for Plan and Implement phases', () => {
  const engine = new Harness2RecursiveEngine();

  const planPrompt = engine.generatePhaseSystemPrompt('plan', ['Focus on call graph exploration']);
  assert.ok(planPrompt.includes('[PHASE: PLAN]'));
  assert.ok(planPrompt.includes('Focus on call graph exploration'));
  assert.ok(planPrompt.includes('Code editing tools are FORBIDDEN') || planPrompt.includes('read-only'));

  const implementPrompt = engine.generatePhaseSystemPrompt('implement', ['Require reproduction test']);
  assert.ok(implementPrompt.includes('[PHASE: IMPLEMENT]'));
  assert.ok(implementPrompt.includes('Require reproduction test'));
  assert.ok(implementPrompt.includes('Surgical') || implementPrompt.includes('atomic'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:harness2`
Expected: FAIL with "engine.generatePhaseSystemPrompt is not a function"

- [ ] **Step 3: Implement `generatePhaseSystemPrompt` in `Harness2RecursiveEngine`**

Triển khai phương thức:
- Kết hợp Core Agent Persona (`You are MinusCLI...`).
- Nhúng định hướng chuẩn từ `SECTION_PHASE_PLAN_GUIDANCE` (khi phase='plan') hoặc `SECTION_PHASE_IMPLEMENT_GUIDANCE` (khi phase='implement').
- Tích hợp thêm các directives và guardrails tùy biến đã được tối ưu hóa qua các vòng lặp Harness².

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:harness2`
Expected: PASS

- [ ] **Step 5: Impact & Graph change review and Commit**

```bash
git add src/agent/harness2-bridge.ts src/agent/harness2-bridge.test.ts
git commit -m "feat(harness2): implement generatePhaseSystemPrompt bridging harness2 and runtime phase guidance"
```

---

### Task 4: Phase-Aware Probe Evaluation in Runner

**Files:**
- Modify: `scripts/run-propose-probe-compose.ts`

**Interfaces:**
- Consumes: CLI flag `--phase=plan|implement|both`
- Produces: Dual-phase probe evaluation reporting contrasts for both planning and implementation

- [ ] **Step 1: Add phase argument parsing to runner script**

Trong `scripts/run-propose-probe-compose.ts`:
- Nhận diện `--phase=plan`, `--phase=implement` hoặc `--phase=both` (mặc định 'both').
- Khi chạy pha `plan`:
  - Khởi tạo `baseScaffold` với `phase: 'plan'`.
  - Thăm dò candidates với `options: { phase: 'plan' }`.
  - Đánh giá khả năng bảo toàn tính read-only và phân rã task.
- Khi chạy pha `implement`:
  - Khởi tạo `baseScaffold` với `phase: 'implement'`.
  - Đánh giá khả năng sửa lỗi và vượt qua test suite.

- [ ] **Step 2: Run verification cycle for Plan mode**

Run: `npx tsx scripts/run-propose-probe-compose.ts --task=task-bugfix-growth-rate --phase=plan`
Expected: Hiển thị kết quả Propose-Probe-Compose riêng biệt cho Plan mode với điểm số và tương phản hành vi của Plan scaffolding.

- [ ] **Step 3: Run verification cycle for Implement mode**

Run: `npx tsx scripts/run-propose-probe-compose.ts --task=task-bugfix-growth-rate --phase=implement`
Expected: Hiển thị kết quả Propose-Probe-Compose cho Implement mode.

- [ ] **Step 4: Commit**

```bash
git add scripts/run-propose-probe-compose.ts
git commit -m "feat(harness2): add dual-phase probe evaluation to propose-probe-compose runner"
```

---

### Task 5: End-to-End Suite Verification & Export Sync

**Files:**
- Modify: `scripts/harness2-minus-bridge.ts`
- Modify: `docs/superpowers/plans/2026-10-23-harness2-plan-implement-system-prompt.md`

**Interfaces:**
- Consumes: All components from Tasks 1-4
- Produces: Fully verified test suite and synced bundles on disk

- [ ] **Step 1: Run complete unit test suite**

Run: `npm run test:harness2`
Expected: PASS (Tất cả các unit tests từ Task 1 đến Task 4 đều đạt 100%)

- [ ] **Step 2: Export dual-phase bundle to disk**

Run: `npm run harness:export`
Expected: Xuất thành công `systemprompt.md`, `systemprompt_plan.md`, `systemprompt_implement.md` và các thành phần khác vào `external/harness2/runs/minus_harness`.

- [ ] **Step 3: Verify import round-trip**

Run: `npx tsx scripts/harness2-minus-bridge.ts --import`
Expected: Nạp thành công và hiển thị thống kê cả 2 prompt Plan và Implement.

- [ ] **Step 4: Final commit**

```bash
git add scripts/harness2-minus-bridge.ts docs/superpowers/plans/2026-10-23-harness2-plan-implement-system-prompt.md
git commit -m "chore(harness2): complete end-to-end verification of plan and implement prompt optimization"
```
