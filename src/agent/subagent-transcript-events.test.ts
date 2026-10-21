import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from './agent-loop.js';
import { ToolRegistry } from '../tools/registry.js';
import { Session } from '../session/session.js';
import { KernelEventBus } from '../kernel/kernel.js';
import { currentSubagentOutputSessionId, runWithSubagentOutput } from './subagent-output-context.js';

test('Subagent loop phát event lên bus của parent kèm cờ isSubagent', () => {  const bus = new KernelEventBus();
  const statuses: any[] = [];
  const toolEvents: any[] = [];
  bus.on('agent/status', (record: any) => statuses.push(record));
  bus.on('tool:before', (_name: string, _args: unknown, ctx: any) => toolEvents.push(ctx));

  const parentLoop = new AgentLoop({ generate: async () => ({}) } as any, new ToolRegistry(), { eventBus: bus });
  const childSession = new Session('session-sub-x');
  const child = (parentLoop as any).createSubagentLoop(
    'sub-x',
    childSession,
    { parentSessionId: 'parent-1' },
    new AbortController().signal,
  );

  assert.ok(statuses.length >= 1, 'parent phải báo trạng thái subagent để TUI tạo tab');
  assert.equal(statuses[0].isSubagent, true);
  assert.equal(statuses[0].sessionId, 'session-sub-x');

  // Mọi event của child đều mang cờ isSubagent (UI tách transcript con khỏi transcript cha).
  (child as any).eventBus.emit('tool:before', 'read_file', { path: 'a.ts' }, { sessionId: 'session-sub-x' });
  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0].isSubagent, true);
  assert.equal(toolEvents[0].sessionId, 'session-sub-x');
});

test('Ngữ cảnh async gắn nhãn stdout của subagent (không trôi vào agent cha)', async () => {
  assert.equal(currentSubagentOutputSessionId(), undefined);
  await runWithSubagentOutput('session-sub-y', async () => {
    assert.equal(currentSubagentOutputSessionId(), 'session-sub-y');
    await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(currentSubagentOutputSessionId(), 'session-sub-y', 'nhãn đi qua await');
  });
  assert.equal(currentSubagentOutputSessionId(), undefined, 'nhãn không rò ra ngoài');
});
