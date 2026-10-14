import test from 'node:test';
import assert from 'node:assert/strict';
import { EffortScope, resolveEffortForRequest } from './token-config.js';

test('effort frozen for providers without per-message updates', () => {
  assert.equal(resolveEffortForRequest('low', 'high', 'gemini'), 'low');
  assert.equal(resolveEffortForRequest('low', 'high', 'deepseek'), 'low');
});

test('effort updates pass through on allowlisted providers', () => {
  assert.equal(resolveEffortForRequest('low', 'high', 'anthropic'), 'high');
  assert.equal(resolveEffortForRequest('low', 'high', 'openai'), 'high');
});

test('EffortScope freezes first value', () => {
  const scope = new EffortScope('medium');
  assert.equal(scope.forRequest('high', 'gemini'), 'medium');
  assert.equal(scope.forRequest('high', 'openai'), 'high');
});
