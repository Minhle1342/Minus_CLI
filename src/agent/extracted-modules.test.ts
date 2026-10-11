import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRequestAnalysis, parseRequestAnalysisFields } from './request-analysis.js';
import { calculateTaskComplexity, resolveRuntimeHarnessProfile } from './task-complexity.js';

test('request-analysis exports function extractRequestAnalysis correctly', () => {
  const block = '[REQUEST ANALYSIS]\nGoal: Refactor\nScope: src/agent\n[/REQUEST ANALYSIS]';
  assert.equal(extractRequestAnalysis(block), 'Goal: Refactor\nScope: src/agent');
});

test('request-analysis parses structured fields with parseRequestAnalysisFields', () => {
  const parsed = parseRequestAnalysisFields('Goal: Fix bug\nScope: src/ui\nPlan: Refactor\nRisk: Low');
  assert.equal(parsed.goal, 'Fix bug');
  assert.equal(parsed.scope, 'src/ui');
  assert.equal(parsed.plan, 'Refactor');
  assert.equal(parsed.risk, 'Low');
});

test('task-complexity computes complexity scale factor based on request', () => {
  const res = calculateTaskComplexity('Fix Error: at test.ts:10:5', 'bugfix');
  assert.ok(res.score > 0.5);
  assert.ok(res.scaleFactor > 1.0);
  assert.match(res.reason, /Bugfix\/security/);
});

test('task-complexity resolves harness profile per task class and phase', () => {
  const bugProfile = resolveRuntimeHarnessProfile('bugfix', 'implement');
  assert.equal(bugProfile.profileName, 'strict-verification');
  assert.equal(bugProfile.criticStrictness, 'strict');

  const exploreProfile = resolveRuntimeHarnessProfile('feature', 'explore');
  assert.equal(exploreProfile.profileName, 'read-only-guard');

  const featureProfile = resolveRuntimeHarnessProfile('feature', 'implement');
  assert.equal(featureProfile.profileName, 'velocity-first');
});
