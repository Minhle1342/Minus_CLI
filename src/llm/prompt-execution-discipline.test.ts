import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextCompactor } from '../agent/context-compactor.js';
import { PromptAssembler } from './prompt-assembler.js';
import { CORE_SYSTEM_PROMPT, DEFAULT_PROMPT_SECTIONS } from './prompt-sections.js';

const EXECUTION_ECONOMY_BLOCK = CORE_SYSTEM_PROMPT.includes('6. EXECUTION ECONOMY')
  ? CORE_SYSTEM_PROMPT.slice(CORE_SYSTEM_PROMPT.indexOf('6. EXECUTION ECONOMY'))
  : '';

test('execution economy keeps parallel read batching explicit', () => {
  assert.match(CORE_SYSTEM_PROMPT, /6\. EXECUTION ECONOMY:/);
  assert.match(EXECUTION_ECONOMY_BLOCK, /read-only/i, 'must scope batching to read-only tools');
  assert.match(EXECUTION_ECONOMY_BLOCK, /ONE response/i, 'must ask for a single batched response');
  assert.match(EXECUTION_ECONOMY_BLOCK, /concurrently/i, 'must state the harness runs them concurrently');
  assert.match(EXECUTION_ECONOMY_BLOCK, /Mutations stay serial/i, 'must state mutations are serialized');
});

test('execution economy requires re-reading changed files and evidence sufficiency', () => {
  assert.match(EXECUTION_ECONOMY_BLOCK, /Re-read a file after it changes/i);
  assert.match(EXECUTION_ECONOMY_BLOCK, /earlier reads are stale/i);
  assert.match(EXECUTION_ECONOMY_BLOCK, /evidence needed to answer is complete/i);
  assert.match(EXECUTION_ECONOMY_BLOCK, /smallest discriminating check/i);
});

test('execution economy does not forbid repeats or stop early', () => {
  // Regression guard: the earlier draft said "Never repeat a tool call" and
  // "stop and answer", which conflicted with re-read-after-edit and parallel batches.
  assert.doesNotMatch(CORE_SYSTEM_PROMPT, /never repeat a tool call/i);
  assert.doesNotMatch(CORE_SYSTEM_PROMPT, /stop and answer/i);
});

test('execution economy block stays small and the core prompt stays lean', () => {
  assert.ok(EXECUTION_ECONOMY_BLOCK.length > 0, 'section 6 must exist');
  assert.ok(EXECUTION_ECONOMY_BLOCK.length <= 900, `section 6 grew to ${EXECUTION_ECONOMY_BLOCK.length} chars`);
  const tokens = ContextCompactor.estimateTokens(CORE_SYSTEM_PROMPT);
  assert.ok(tokens < 1500, `core prompt exceeded the lean budget: ~${tokens} tokens`);
});

test('default sections keep a stable T0-T2 prefix when only the T3 tail changes', () => {
  const assembler = new PromptAssembler();
  for (const section of DEFAULT_PROMPT_SECTIONS) assembler.register(section);

  const base = assembler.assembleWithEnvelope({}, { provider: 'test', model: 'test-model' });
  const table = assembler.assembleWithEnvelope(
    { request: 'create a table summarizing the options' },
    { provider: 'test', model: 'test-model' },
  );

  assert.equal(base.prompt, assembler.assembleForContext({}), 'envelope prompt must match assembly');
  assert.equal(base.stablePrefixHash, table.stablePrefixHash, 'T3-only change must not break the prefix');
  assert.notEqual(base.prompt, table.prompt, 'the tabular T3 section must actually be appended');
  assert.ok(table.envelope.tiers.some((tier) => tier.tier === 'T3'));
});
