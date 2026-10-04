import assert from 'node:assert/strict';
import test from 'node:test';
import { DynamicContextArbiter } from './dynamic-context-arbiter.js';

test('preserves the response-language directive under a constrained dynamic-context budget', () => {
  const arbiter = new DynamicContextArbiter(20);
  const result = arbiter.arbitrate({
    responseLanguageDirective: '[RESPONSE LANGUAGE]: Answer in the same natural language as the current user request.',
    repositoryContext: 'unrelated repository context '.repeat(200),
  });

  assert.match(result.renderedContext, /RESPONSE LANGUAGE/);
  assert.ok(result.sourcesIncluded.includes('Response Language Directive (P0.85)'));
});
