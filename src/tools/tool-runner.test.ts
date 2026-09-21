import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ToolRegistry } from './registry.js';
import { ToolRunner, TurnBudgetTracker } from './tool-runner.js';
import { Workspace } from '../workspace/workspace.js';
import { hashAllowedToolSet } from '../control/this-turn-tool-gate.js';
import type { ToolDefinition } from './types.js';

describe('ToolRunner & TurnBudgetTracker Suite', () => {
  const workspace = new Workspace(process.cwd());

  it('1. TurnBudgetTracker chia sẻ chính xác giữa runner gốc và các scoped sub-runners', async () => {
    const registry = new ToolRegistry();
    const mockTool: ToolDefinition = {
      name: 'test_read',
      description: 'Test read tool',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
      },
      execute: async (args) => ({ success: true, value: args.key }),
    };
    registry.register(mockTool);

    const parentRunner = new ToolRunner(registry, workspace);
    const decisionId = 'decision-turn-1';
    const allowed = ['test_read'];
    const hash = hashAllowedToolSet(allowed);

    const contextTurn1Step1 = {
      decisionId,
      allowedToolNames: allowed,
      allowedToolSetHash: hash,
      turn: 1,
      maxToolCalls: 2,
    };

    // Sub-runner 1 cho step 1
    const scopedRunner1 = parentRunner.createScoped(registry);
    const res1 = await scopedRunner1.run('test_read', { key: 'step1' }, contextTurn1Step1);
    assert.equal(res1.result.success, true);
    assert.equal(scopedRunner1.scopedCallCount, 1);
    assert.equal(parentRunner.scopedCallCount, 1);

    // Sub-runner 2 cho step 2 (mô phỏng step tiếp theo trong agent-loop)
    const contextTurn1Step2 = {
      ...contextTurn1Step1,
      turn: 1,
    };
    const scopedRunner2 = parentRunner.createScoped(registry);
    const res2 = await scopedRunner2.run('test_read', { key: 'step2' }, contextTurn1Step2);
    assert.equal(res2.result.success, true);
    assert.equal(scopedRunner2.scopedCallCount, 2);
    assert.equal(parentRunner.scopedCallCount, 2);

    // Sub-runner 3 cho step 3: vượt ngân sách (maxToolCalls = 2)
    const scopedRunner3 = parentRunner.createScoped(registry);
    const res3 = await scopedRunner3.run('test_read', { key: 'step3' }, contextTurn1Step2);
    assert.equal(res3.result.errorCode, 'TOOL_CALL_BUDGET_EXHAUSTED');
    assert.equal(res3.guardianDiagnosis?.category, 'BUDGET_EXHAUSTED');
  });

  it('2. TurnBudgetTracker tự động reset khi chuyển turn mới', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'ping',
      description: 'Ping tool',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ pong: true }),
    });

    const runner = new ToolRunner(registry, workspace);
    const allowed = ['ping'];
    const hash = hashAllowedToolSet(allowed);

    // Turn 1: dùng hết ngân sách (1 call)
    const ctxTurn1 = {
      decisionId: 'd-1',
      allowedToolNames: allowed,
      allowedToolSetHash: hash,
      turn: 1,
      maxToolCalls: 1,
    };
    const res1 = await runner.run('ping', {}, ctxTurn1);
    assert.equal(res1.result.pong, true);

    const res1Blocked = await runner.run('ping', {}, ctxTurn1);
    assert.equal(res1Blocked.result.errorCode, 'TOOL_CALL_BUDGET_EXHAUSTED');

    // Chuyển sang Turn 2: Ngân sách được cấp mới
    const ctxTurn2 = {
      decisionId: 'd-2',
      allowedToolNames: allowed,
      allowedToolSetHash: hash,
      turn: 2,
      maxToolCalls: 1,
    };
    const res2 = await runner.run('ping', {}, ctxTurn2);
    assert.equal(res2.result.pong, true, 'Turn 2 được reset ngân sách và thực thi thành công');
  });

  it('3. Stage 0 cung cấp Actionable Guidance và Guardian Diagnosis khi bị từ chối quyền theo phase', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'replace_text',
      description: 'Replace text tool',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      execute: async () => ({ success: true }),
    });

    const runner = new ToolRunner(registry, workspace);
    const allowed = ['read_file', 'create_plan'];
    const hash = hashAllowedToolSet(allowed);

    const ctx = {
      decisionId: 'd-plan-phase',
      allowedToolNames: allowed,
      allowedToolSetHash: hash,
      classificationPhase: 'plan',
      turn: 1,
    };

    const res = await runner.run('replace_text', { path: 'file.ts' }, ctx);
    assert.equal(res.result.errorCode, 'TOOL_NOT_ALLOWED_THIS_TURN');
    assert.match(res.result.error, /phase "plan"/);
    assert.match(res.result.error, /create_plan/);
    assert.equal(res.guardianDiagnosis?.category, 'AUTHORIZATION_DENIED');
    assert.match(String(res.guardianDiagnosis?.recoveryAction), /create_plan/);
  });

  it('4. Stage 3 rà soát an ninh cho mọi alias đường dẫn (filePath, file, path)', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'write_file',
      description: 'Write file',
      parameters: {
        type: 'object',
        properties: { filePath: { type: 'string' }, content: { type: 'string' } },
        required: ['filePath', 'content'],
      },
      execute: async () => ({ success: true }),
    });

    const runner = new ToolRunner(registry, workspace);

    // a. Kiểm tra Path Traversal qua filePath
    const traversalRes = await runner.run('write_file', {
      filePath: '../../../../outside.txt',
      content: 'malicious',
    });
    assert.equal(traversalRes.result.errorCode, 'SECURITY_VIOLATION');
    assert.equal(traversalRes.guardianDiagnosis?.category, 'SECURITY_VIOLATION');

    // b. Kiểm tra Protected File qua filePath
    workspace.addProtectedFile('secret.config');
    const protectedRes = await runner.run('write_file', {
      filePath: 'secret.config',
      content: '{}',
    });
    assert.equal(protectedRes.result.errorCode, 'SECURITY_VIOLATION');
    assert.match(protectedRes.result.error, /cấu hình nhạy cảm/);
  });

  it('5. Stage 5 bảo toàn Tool Output Schema chặt chẽ khi có Runtime Metadata Enrichment', async () => {
    const registry = new ToolRegistry();
    // Tool khai báo outputSchema rất chặt (chỉ có path và success, KHÔNG có lsp hay blastRadius)
    const strictMutationTool: ToolDefinition = {
      name: 'replace_text',
      description: 'Strict mutation tool',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          path: { type: 'string' },
        },
        required: ['success', 'path'],
        additionalProperties: false,
      },
      execute: async (args) => ({
        success: true,
        path: args.path,
      }),
    };
    registry.register(strictMutationTool);

    const runner = new ToolRunner(registry, workspace);
    const res = await runner.run('replace_text', { path: 'src/tools/registry.ts' });

    // Kết quả phải thành công, KHÔNG được báo lỗi INVALID_TOOL_RESULT do dính blastRadius/lsp
    assert.equal(res.result.success, true);
    assert.equal(res.result.path, 'src/tools/registry.ts');
    assert.equal(res.result.errorCode, undefined);
  });

  it('6. Stage 4 phản hồi lập tức khi AbortSignal bị hủy', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'slow_tool',
      description: 'Slow tool',
      parameters: { type: 'object', properties: {} },
      execute: async () => new Promise((resolve) => setTimeout(resolve, 500)),
    });

    const runner = new ToolRunner(registry, workspace);
    const controller = new AbortController();
    controller.abort();

    const res = await runner.run('slow_tool', {}, { signal: controller.signal });
    assert.equal(res.result.errorCode, 'ABORTED_BEFORE_DISPATCH');
  });

  it('7. Hoạt động chính xác theo 3 chế độ MINUS_TOOL_CONTROL_MODE (off, shadow, enforce)', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'unauthorized_tool',
      description: 'Tool outside allowlist',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ executed: true }),
    });

    const runner = new ToolRunner(registry, workspace);
    const allowed = ['authorized_tool_only'];
    const hash = hashAllowedToolSet(allowed);

    const baseContext = {
      decisionId: 'decision-3-modes',
      allowedToolNames: allowed,
      allowedToolSetHash: hash,
      classificationPhase: 'plan',
      turn: 1,
    };

    // A. Mode ENFORCE: Chặn đứng và trả về lỗi
    const enforceRes = await runner.run('unauthorized_tool', {}, {
      ...baseContext,
      controlMode: 'enforce',
    });
    assert.equal(enforceRes.result.errorCode, 'TOOL_NOT_ALLOWED_THIS_TURN');
    assert.equal(enforceRes.result.executed, undefined);
    assert.equal(enforceRes.guardianDiagnosis?.category, 'AUTHORIZATION_DENIED');

    // B. Mode SHADOW: Không chặn, ghi nhận shadowObservation và cho phép thực thi
    const shadowRes = await runner.run('unauthorized_tool', {}, {
      ...baseContext,
      controlMode: 'shadow',
    });
    assert.equal(shadowRes.result.executed, true, 'Shadow mode cho phép thực thi tool');
    assert.equal(shadowRes.shadowObservation?.wouldAllow, false, 'Shadow observation đánh dấu wouldAllow = false');
    assert.equal(shadowRes.shadowObservation?.errorCode, 'TOOL_NOT_ALLOWED_THIS_TURN');

    // C. Mode OFF: Bỏ qua hoàn toàn Stage 0, không can thiệp, thực thi mượt mà
    const offRes = await runner.run('unauthorized_tool', {}, {
      ...baseContext,
      controlMode: 'off',
    });
    assert.equal(offRes.result.executed, true, 'Off mode cho phép thực thi tool');
    assert.equal(offRes.shadowObservation, undefined, 'Off mode không ghi nhận shadowObservation');
  });
});
