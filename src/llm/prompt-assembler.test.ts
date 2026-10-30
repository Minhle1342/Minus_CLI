import assert from 'node:assert/strict';
import test from 'node:test';
import { PromptAssembler } from './prompt-assembler.js';
import type { PromptSection } from './prompt-assembler.js';

const OPTIONS = { provider: 'test', model: 'test-model' };

function build(sections: PromptSection[]): PromptAssembler {
  const assembler = new PromptAssembler();
  for (const section of sections) assembler.register(section);
  return assembler;
}

test('envelope prompt is byte-identical to assembleForContext', () => {
  const assembler = build([
    { id: 'core', content: 'Core rules.', priority: -1000 },
    { id: 'repo', content: 'Repo rules.', priority: 100 },
    { id: 'session', content: 'Session directive.', priority: 700 },
    { id: 'tail', content: 'Dynamic tail.', priority: 2000 },
    { id: 'skipped', content: 'Hidden.', priority: 50, condition: () => false },
  ]);

  const assembled = assembler.assembleForContext({});
  const withEnvelope = assembler.assembleWithEnvelope({}, OPTIONS);
  assert.equal(withEnvelope.prompt, assembled);

  const sectionIds = withEnvelope.sections.map((section) => section.id);
  assert.deepEqual(sectionIds, ['core', 'repo', 'session', 'tail']);
  assert.deepEqual(withEnvelope.sections.map((section) => section.tier), ['T0', 'T1', 'T2', 'T3']);
  assert.ok(withEnvelope.envelope.tiers.some((tier) => tier.tier === 'T3'));
});

test('T3-only churn does not change the stable prefix hash', () => {
  const base: PromptSection[] = [
    { id: 'core', content: 'Core rules.', priority: -1000 },
    { id: 'repo', content: 'Repo rules.', priority: 100 },
  ];
  const left = build([...base, { id: 'tail', content: 'Tail one.', priority: 2000 }]);
  const right = build([...base, { id: 'tail', content: 'Tail two.', priority: 2000 }]);

  const leftResult = left.assembleWithEnvelope({}, OPTIONS);
  const rightResult = right.assembleWithEnvelope({}, OPTIONS);

  assert.notEqual(leftResult.prompt, rightResult.prompt, 'prompt bytes must differ');
  assert.equal(leftResult.stablePrefixHash, rightResult.stablePrefixHash, 'T0..T2 must stay stable');
  assert.equal(leftResult.envelope.cacheKey, rightResult.envelope.cacheKey, 'cache key ignores the T3 tail');
});

test('stable prefix hash changes when a T0/T1/T2 section changes', () => {
  const left = build([{ id: 'core', content: 'Core rules.', priority: -1000 }]).assembleWithEnvelope({}, OPTIONS);
  const right = build([{ id: 'core', content: 'Core rules v2.', priority: -1000 }]).assembleWithEnvelope({}, OPTIONS);
  const tailOnly = build([
    { id: 'core', content: 'Core rules.', priority: -1000 },
    { id: 'tail', content: 'Tail.', priority: 2000 },
  ]).assembleWithEnvelope({}, OPTIONS);

  assert.notEqual(left.stablePrefixHash, right.stablePrefixHash);
  assert.equal(left.stablePrefixHash, tailOnly.stablePrefixHash);
});

test('section digests are deterministic and canonicalized', () => {
  const clean = build([{ id: 'repo', content: 'Repo rules.', priority: 100 }]);
  const noisy = build([{ id: 'repo', content: 'Repo rules.   \r\n', priority: 100 }]);

  const cleanResult = clean.assembleWithEnvelope({}, OPTIONS);
  const noisyResult = noisy.assembleWithEnvelope({}, OPTIONS);

  assert.equal(cleanResult.prompt, noisyResult.prompt);
  assert.deepEqual(cleanResult.sections, noisyResult.sections);
  assert.equal(cleanResult.sections[0].contentHash.length, 64);
  assert.equal(cleanResult.stablePrefixHash.length, 64);
});

test('conditional sections appear only when their condition passes', () => {
  const assembler = build([
    { id: 'core', content: 'Core.', priority: -1000 },
    { id: 'optional', content: 'Optional.', priority: 100, condition: (ctx: any) => Boolean(ctx?.includeOptional) },
  ]);

  const off = assembler.assembleWithEnvelope({}, OPTIONS);
  const on = assembler.assembleWithEnvelope({ includeOptional: true } as any, OPTIONS);

  assert.deepEqual(off.sections.map((section) => section.id), ['core']);
  assert.deepEqual(on.sections.map((section) => section.id), ['core', 'optional']);
  assert.notEqual(off.stablePrefixHash, on.stablePrefixHash);
});
