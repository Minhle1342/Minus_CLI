import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGeminiWebModel } from './gemini-web.js';

test('detects web models by name prefix', () => {
  assert.equal(isGeminiWebModel('gemini-web-flash'), true);
  assert.equal(isGeminiWebModel('gemini-3.7-flash'), false);
  assert.equal(isGeminiWebModel('auto-fallback'), false);
});
