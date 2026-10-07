import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CORE_SYSTEM_PROMPT } from './prompt-sections.js';

test('core prompt defines one submission rule for both read-only and mutation tasks', () => {
  assert.equal(CORE_SYSTEM_PROMPT.match(/submit_solution/g)?.length, 1);
  assert.match(CORE_SYSTEM_PROMPT, /any task, call submit_solution alone as the final tool call/);
  assert.match(CORE_SYSTEM_PROMPT, /actual answer in summary/);
  assert.match(CORE_SYSTEM_PROMPT, /Read-only requires no edits\/tests/);
  assert.match(CORE_SYSTEM_PROMPT, /observed verification after the last edit/);
  assert.match(CORE_SYSTEM_PROMPT, /If rejected, address the rejection and retry/);
  assert.match(CORE_SYSTEM_PROMPT, /After success, call no more tools; return the submitted answer/);
  assert.doesNotMatch(CORE_SYSTEM_PROMPT, /without tests or submission tool|no .*reporting tool required/);
});
