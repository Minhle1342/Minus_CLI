import assert from 'node:assert/strict';
import test from 'node:test';
import { createRootModel } from '../models/root-model.js';
import { update } from '../models/root-model.js';
import { runWithSubagentOutput } from '../../../agent/subagent-output-context.js';

test('subagent tab receives structured kernel entries cleanly without raw ANSI stdout leak', () => {
  let model = createRootModel();
  const subSessionId = 'session-subagent-clean-1';

  // 1. Subagent registered via agent:status
  [model] = update({
    type: 'kernel',
    event: 'agent:status',
    args: [{
      id: 'subagent-1',
      status: 'running',
      sessionId: subSessionId,
      name: 'Subagent: refactor auth',
      isSubagent: true,
    }],
  }, model);

  const subTab = model.sessions.tabs.find(t => t.id === subSessionId);
  assert.ok(subTab, 'Subagent tab should be registered');
  assert.equal(subTab?.subagent, true);

  // 2. Structured tool:before event
  [model] = update({
    type: 'kernel',
    event: 'tool:before',
    args: ['read_file', { path: 'src/auth.ts' }, { sessionId: subSessionId, isSubagent: true }],
  }, model);

  // 3. Structured tool:after event
  [model] = update({
    type: 'kernel',
    event: 'tool:after',
    args: ['read_file', { content: 'export const auth = true;' }, 12, { path: 'src/auth.ts' }, { sessionId: subSessionId, isSubagent: true }],
  }, model);

  // 4. Structured final answer
  [model] = update({
    type: 'kernel',
    event: 'model:final_answer',
    args: ['Refactor complete.', { sessionId: subSessionId, isSubagent: true }],
  }, model);

  const updatedTab = model.sessions.tabs.find(t => t.id === subSessionId)!;
  const entries = updatedTab.entries || [];
  assert.ok(entries.length >= 2, 'Should have structured tool and answer entries');
  assert.ok(entries.some(e => e.kind === 'tool' && e.text.includes('read_file')), 'Should have tool entry');
  assert.ok(entries.some(e => e.kind === 'answer' && e.text.includes('Refactor complete.')), 'Should have answer entry');

  // Verify that no raw log entries leaked
  assert.ok(!entries.some(e => e.kind === 'log'), 'Should not contain raw log entries');
});
