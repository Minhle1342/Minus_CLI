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

test('dedups P3 re-injected lines already present in history without touching unique lines', () => {
  const arbiter = new DynamicContextArbiter(2000);
  const duplicateLine = 'Anti-pattern observed in prior turn: never repeat identical failing shell commands';
  const result = arbiter.arbitrate({
    recalledTurnContext: ['# Selective Re-injection', duplicateLine, 'A brand-new finding about the router module timeout'].join('\n'),
  }, {
    existingHistoryContext: `warm start\n${duplicateLine}`,
  });

  assert.doesNotMatch(result.renderedContext, /never repeat identical failing shell commands/);
  assert.match(result.renderedContext, /brand-new finding about the router module timeout/);
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

test('ranks and includes dynamic guidance sources (frontend P1.36, codebase intelligence P1.37, orchestrator P1.38)', () => {
  const arbiter = new DynamicContextArbiter(1000);
  const result = arbiter.arbitrate({
    frontendGuidance: '[FRONTEND & UI DESIGN STANDARD]: Inspect CSS tokens and components.',
    codebaseIntelligenceGuidance: '[CODEBASE ARCHITECTURE]: codegraph_explore first for structural questions.',
    orchestratorGuidance: '[TASK ORCHESTRATOR BOUNDARIES]: Delegate to subagents.',
  });

  assert.ok(result.sourcesIncluded.includes('Dynamic Frontend Guidance (P1.36)'));
  assert.ok(result.sourcesIncluded.includes('Dynamic Codebase Intelligence Guidance (P1.37)'));
  assert.ok(result.sourcesIncluded.includes('Dynamic Orchestrator Guidance (P1.38)'));

  const frontendIdx = result.renderedContext.indexOf('FRONTEND & UI DESIGN STANDARD');
  const codebaseIdx = result.renderedContext.indexOf('CODEBASE ARCHITECTURE');
  const orchestratorIdx = result.renderedContext.indexOf('TASK ORCHESTRATOR BOUNDARIES');

  assert.ok(frontendIdx !== -1 && codebaseIdx !== -1 && orchestratorIdx !== -1);
  assert.ok(frontendIdx < codebaseIdx, 'P1.36 should precede P1.37');
  assert.ok(codebaseIdx < orchestratorIdx, 'P1.37 should precede P1.38');
});
