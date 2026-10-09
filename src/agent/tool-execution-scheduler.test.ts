import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isEvidenceSinkTool,
  reorderScheduledToolCalls,
  partitionToolCalls,
  type ScheduledToolCall,
} from './tool-execution-scheduler.js';

test('isEvidenceSinkTool identifies completion tools correctly', () => {
  assert.equal(isEvidenceSinkTool({ name: 'update_plan_task', args: { status: 'COMPLETED', id: 1 } }), true);
  assert.equal(isEvidenceSinkTool({ name: 'update_plan_task', args: { status: 'completed', id: 1 } }), true);
  assert.equal(isEvidenceSinkTool({ name: 'update_plan_task', args: { status: 'IN_PROGRESS', id: 1 } }), false);
  assert.equal(isEvidenceSinkTool({ name: 'update_plan_task', args: { status: 'FAILED', id: 1 } }), false);
  assert.equal(isEvidenceSinkTool({ name: 'read_file', args: { path: 'a.ts' } }), false);
  assert.equal(isEvidenceSinkTool({ name: 'run_command', args: { command: 'npm test' } }), false);
  assert.equal(isEvidenceSinkTool({ name: 'replace_text', args: { path: 'a.ts' } }), false);
});

test('reorderScheduledToolCalls pushes update_plan_task(COMPLETED) to the end of the batch', () => {
  const calls: ScheduledToolCall[] = [
    { index: 0, id: 'call-0', name: 'update_plan_task', args: { id: 1, status: 'COMPLETED' } },
    { index: 1, id: 'call-1', name: 'read_file', args: { path: 'src/ui/cli-ui.ts' } },
    { index: 2, id: 'call-2', name: 'read_file', args: { path: 'src/ui/tui-theme.ts' } },
  ];

  const reordered = reorderScheduledToolCalls(calls);

  assert.equal(reordered.length, 3);
  assert.equal(reordered[0].name, 'read_file');
  assert.equal(reordered[0].id, 'call-1');
  assert.equal(reordered[1].name, 'read_file');
  assert.equal(reordered[1].id, 'call-2');
  assert.equal(reordered[2].name, 'update_plan_task');
  assert.equal(reordered[2].id, 'call-0');
});

test('reorderScheduledToolCalls preserves order when no sink tools or only sink tools exist', () => {
  const readOnlyCalls: ScheduledToolCall[] = [
    { index: 0, id: 'c-0', name: 'read_file', args: { path: 'a.ts' } },
    { index: 1, id: 'c-1', name: 'read_file', args: { path: 'b.ts' } },
  ];
  assert.deepEqual(reorderScheduledToolCalls(readOnlyCalls), readOnlyCalls);

  const sinkOnlyCalls: ScheduledToolCall[] = [
    { index: 0, id: 'c-0', name: 'update_plan_task', args: { id: 1, status: 'COMPLETED' } },
  ];
  assert.deepEqual(reorderScheduledToolCalls(sinkOnlyCalls), sinkOnlyCalls);

  const mixedInterleaved: ScheduledToolCall[] = [
    { index: 0, id: 'c-0', name: 'read_file', args: { path: 'a.ts' } },
    { index: 1, id: 'c-1', name: 'update_plan_task', args: { id: 1, status: 'COMPLETED' } },
    { index: 2, id: 'c-2', name: 'run_command', args: { command: 'npm test' } },
  ];
  const result = reorderScheduledToolCalls(mixedInterleaved);
  assert.deepEqual(result.map((c) => c.name), ['read_file', 'run_command', 'update_plan_task']);
});

test('partitionToolCalls works seamlessly with reordered calls allowing concurrent reads', () => {
  const calls: ScheduledToolCall[] = [
    { index: 0, id: 'call-0', name: 'update_plan_task', args: { id: 1, status: 'COMPLETED' } },
    { index: 1, id: 'call-1', name: 'read_file', args: { path: 'src/ui/cli-ui.ts' } },
    { index: 2, id: 'call-2', name: 'read_file', args: { path: 'src/ui/tui-theme.ts' } },
  ];

  const reordered = reorderScheduledToolCalls(calls).map((item, idx) => ({
    ...item,
    index: idx,
  }));

  const partitions = partitionToolCalls(reordered, true);
  assert.equal(partitions.length, 2);
  assert.equal(partitions[0].mode, 'concurrent-read');
  assert.equal(partitions[0].calls.length, 2);
  assert.equal(partitions[1].mode, 'sequential');
  assert.equal(partitions[1].calls[0].name, 'update_plan_task');
});
