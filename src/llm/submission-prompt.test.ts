import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CORE_SYSTEM_PROMPT, SECTION_PHASE_VERIFY_GUIDANCE } from './prompt-sections.js';

test('core prompt routes read-only answers directly and keeps submission for other tasks', () => {
  assert.equal(CORE_SYSTEM_PROMPT.match(/submit_solution/g)?.length, 2);
  assert.match(CORE_SYSTEM_PROMPT, /Read-only questions.*return the final answer directly and never call submit_solution/);
  assert.match(CORE_SYSTEM_PROMPT, /any other task, call submit_solution alone as the final tool call/);
  assert.match(CORE_SYSTEM_PROMPT, /actual answer in summary/);
  assert.match(CORE_SYSTEM_PROMPT, /Read-only requires no edits\/tests/);
  assert.match(CORE_SYSTEM_PROMPT, /observed verification after the last edit/);
  assert.match(CORE_SYSTEM_PROMPT, /If rejected, address the rejection and retry/);
  assert.match(CORE_SYSTEM_PROMPT, /After success, call no more tools; return the submitted answer/);
  assert.doesNotMatch(CORE_SYSTEM_PROMPT, /without tests or submission tool|no .*reporting tool required/);
});

test('verify guidance states the tier and impacted-suite rules behind the speculative gates', () => {
  assert.match(SECTION_PHASE_VERIFY_GUIDANCE, /lighter check never satisfies a heavier requirement/);
  assert.match(SECTION_PHASE_VERIFY_GUIDANCE, /one suite passing does not discharge the others/);
});
