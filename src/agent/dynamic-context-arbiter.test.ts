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

test('preserves guaranteed token floor for repositoryContext when minRepoMapFloorTokens is specified (R3 anti-inversion)', () => {
  const arbiter = new DynamicContextArbiter(500);
  const repoMapContent = [
    '# Graph Repository Map',
    'src/agent/agent-loop.ts: 12 callers, 5 callees',
    'src/agent/dynamic-context-arbiter.ts: 10 callers, 2 callees',
    'src/control/classification-engine.ts: 4 callers, 8 callees',
    'src/skills/verification-policy.ts: 6 callers, 3 callees',
  ].join('\n');

  const result = arbiter.arbitrate({
    responseLanguageDirective: '[RESPONSE LANGUAGE]: en',
    cognitiveScaffold: 'Scaffold instructions '.repeat(50),
    toolPlaybooks: 'Tool playbooks '.repeat(30),
    repositoryContext: repoMapContent,
  }, {
    maxBudgetTokens: 200,
    risk: 'R3',
    minRepoMapFloorTokens: 50,
  });

  // Verify repositoryContext was not completely eliminated
  assert.ok(result.sourcesIncluded.includes('Graph Repository Map (P7)'));
  assert.match(result.renderedContext, /Graph Repository Map/);
});
