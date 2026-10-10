import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolRegistry } from './registry.js';
import { ToolRunner, TurnBudgetTracker } from './tool-runner.js';
import { Workspace } from '../workspace/workspace.js';
import { PermissionManager } from '../security/permission-manager.js';
import { hashAllowedToolSet } from '../control/this-turn-tool-gate.js';
import type { ToolDefinition } from './types.js';

describe('Tool session scoping Suite', () => {
  const workspace = new Workspace(process.cwd());

  it('1. TurnBudgetTracker tách budget theo session (cùng turn number không ăn chung)', () => {
    const tracker = new TurnBudgetTracker();
    assert.equal(tracker.increment(3, 'sess-a'), 1);
    assert.equal(tracker.increment(3, 'sess-a'), 2);
    assert.equal(tracker.increment(3, 'sess-b'), 1);
    assert.equal(tracker.getCallCount(3, 'sess-a'), 2);
    assert.equal(tracker.getCallCount(3, 'sess-b'), 1);
    // Không sessionId → bucket legacy chung, hành vi cũ giữ nguyên.
    assert.equal(tracker.increment(3), 1);
    assert.equal(tracker.getCallCount(3), 1);
    tracker.evictSession('sess-a');
    assert.equal(tracker.getCallCount(3, 'sess-a'), 0);
    assert.equal(tracker.getCallCount(3, 'sess-b'), 1);
  });

  it('2. Budget enforce trong run() tách theo sessionId trong context', async () => {
    const registry = new ToolRegistry();
    const mockTool: ToolDefinition = {
      name: 'scoped_read',
      description: 'Scoped read tool',
      parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } as any,
      execute: async (args) => ({ success: true, value: args.key }),
    };
    registry.register(mockTool);
    const runner = new ToolRunner(registry, workspace);
    const allowed = ['scoped_read'];
    const base = {
      decisionId: 'decision-s1',
      allowedToolNames: allowed,
      allowedToolSetHash: hashAllowedToolSet(allowed),
      turn: 1,
      maxToolCalls: 1,
    };
    const first = await runner.run('scoped_read', { key: 'a1' }, { ...base, sessionId: 'sess-a' });
    assert.equal(first.result.success, true);
    const second = await runner.run('scoped_read', { key: 'a2' }, { ...base, sessionId: 'sess-a' });
    assert.equal(second.result.errorCode, 'TOOL_CALL_BUDGET_EXHAUSTED');
    const otherSession = await runner.run('scoped_read', { key: 'b1' }, { ...base, sessionId: 'sess-b' });
    assert.equal(otherSession.result.success, true);
  });

  it('3. Deterministic dedup cache không lan qua session khác', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'allowed_one',
      description: 'Allowed tool',
      parameters: { type: 'object', properties: {} } as any,
      execute: async () => ({ ok: true }),
    });
    const runner = new ToolRunner(registry, workspace);
    const allowed = ['allowed_one'];
    const base = {
      decisionId: 'decision-d1',
      allowedToolNames: allowed,
      allowedToolSetHash: hashAllowedToolSet(allowed),
      turn: 2,
    };
    // 'blocked_tool' không nằm trong allowlist → deterministic block, cache lại.
    const blocked1 = await runner.run('blocked_tool', {}, { ...base, sessionId: 'sess-a' });
    assert.equal(blocked1.result.errorCode, 'TOOL_NOT_ALLOWED_THIS_TURN');
    assert.equal((blocked1.result as any).deduped, undefined);
    const blocked2 = await runner.run('blocked_tool', {}, { ...base, sessionId: 'sess-a' });
    assert.equal((blocked2.result as any).deduped, true);
    // Cùng call, cùng turn nhưng session khác → block mới, không ăn cache của A.
    const blockedOther = await runner.run('blocked_tool', {}, { ...base, sessionId: 'sess-b' });
    assert.equal(blockedOther.result.errorCode, 'TOOL_NOT_ALLOWED_THIS_TURN');
    assert.equal((blockedOther.result as any).deduped, undefined);
  });

  it('4. approve_all_session chỉ có hiệu lực trong đúng session', async () => {
    const pm = new PermissionManager('ask_sensitive');
    let prompts = 0;
    pm.setPromptHandler(async () => {
      prompts++;
      return 'approve_all_session';
    });
    const args = { command: 'git push origin main' }; // MEDIUM → đi qua prompt, stub không execute thật
    const first = await pm.checkPermission('run_command', args, { sessionId: 'sess-a', turn: 1 } as any);
    assert.equal(first.allowed, true);
    assert.equal(prompts, 1);
    // Cùng session → dùng approval đã lưu, không hỏi lại.
    const second = await pm.checkPermission('run_command', args, { sessionId: 'sess-a', turn: 1 } as any);
    assert.equal(second.allowed, true);
    assert.equal(prompts, 1);
    // Session khác → phải hỏi lại, không được duyệt ké.
    const other = await pm.checkPermission('run_command', args, { sessionId: 'sess-b', turn: 1 } as any);
    assert.equal(other.allowed, true);
    assert.equal(prompts, 2);
    // Không sessionId → bucket legacy riêng, cũng phải hỏi.
    const legacy = await pm.checkPermission('run_command', args, { turn: 1 } as any);
    assert.equal(legacy.allowed, true);
    assert.equal(prompts, 3);
    // Evict session A → A phải hỏi lại.
    pm.evictSessionApprovals('sess-a');
    const afterEvict = await pm.checkPermission('run_command', args, { sessionId: 'sess-a', turn: 1 } as any);
    assert.equal(afterEvict.allowed, true);
    assert.equal(prompts, 4);
  });
});
