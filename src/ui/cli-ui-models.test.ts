import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AVAILABLE_MODELS } from './cli-ui.js';

test('picker offers gemini-web model', () => {
  const entry = AVAILABLE_MODELS.find((m) => m.name === 'gemini-web-flash');
  assert.ok(entry, 'AVAILABLE_MODELS must include gemini-web-flash');
  assert.equal(entry!.id, 'gw');
});
