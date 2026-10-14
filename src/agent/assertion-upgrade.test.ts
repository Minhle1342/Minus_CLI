import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DomainIntentGuardian } from './domain-intent-guardian.js';
import { createRunCommandTool } from '../tools/run-command.js';
import { CognitiveHarness } from './cognitive-harness.js';

test('assertion upgrade intent is recognized (nâng cấp assertion)', () => {
  const g = new DomainIntentGuardian();
  g.extractAndFreezeContract('Nâng cấp assertion test cho tính năng tính thuế mới');
  assert.equal(g.getContract()?.allowTestFileModification, true);
});

test('legitimate expected-value upgrade preserves count and is allowed', () => {
  const g = new DomainIntentGuardian();
  g.extractAndFreezeContract('Fix logic in src/finance.ts');
  const r = g.checkAssertionStrength('replace_file_content', {
    TargetContent: 'expect(total).toBe(100)',
    ReplacementContent: 'expect(total).toBe(120)',
  }, 'src/finance.test.ts');
  assert.equal(r.isTampering, false);
  const intervention = g.observeToolCall({
    toolName: 'replace_file_content',
    args: { TargetFile: 'src/finance.test.ts', TargetContent: 'expect(total).toBe(100)', ReplacementContent: 'expect(total).toBe(120)' },
  });
  assert.equal(intervention, null);
});

test('deleting assertions to bypass test is still blocked', () => {
  const g = new DomainIntentGuardian();
  g.extractAndFreezeContract('Fix logic in src/finance.ts');
  const intervention = g.observeToolCall({
    toolName: 'replace_file_content',
    args: { TargetFile: 'src/finance.test.ts', TargetContent: 'expect(a).toBe(1); expect(b).toBe(2)', ReplacementContent: 'expect(a).toBe(1)' },
  });
  assert.notEqual(intervention, null);
  assert.equal(intervention?.type, 'TEST_TAMPERING');
});

test('run_command prompt forbids assertion bypass and orders upgrade-before-test', () => {
  const tool = createRunCommandTool();
  const desc = `${tool.description} ${(tool.parameters as any)?.properties?.command?.description ?? ''}`;
  assert.match(desc, /assert/i);
  assert.match(desc, /bypass/i);
  assert.match(desc, /before.*test|upgrade.*before/i);
});

test('cognitive scaffold verify gate forbids bypass but allows legitimate upgrade', () => {
  const h = new CognitiveHarness();
  const s = h.createScaffold({ request: 'fix bug in calculator', phase: 'verify' });
  const text = s.negativeGate.join('\n');
  assert.match(text, /bypass|disable.*assert/i);
  assert.match(text, /legitimate|before running tests/i);
});
