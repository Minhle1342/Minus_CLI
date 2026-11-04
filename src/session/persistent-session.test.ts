import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadSession, saveSession } from './persistent-session.js';

test('saveSession replaces the file atomically and recovers from corruption', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minus-session-config-'));
  const file = path.join(dir, '.codingagent', 'session.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"modelName":', 'utf8');

  const originalError = console.error;
  console.error = () => {};
  try {
    saveSession({ modelName: 'gemini-3.7-flash' }, dir);
    saveSession({ activeSessionId: 'session-1' }, dir);
  } finally {
    console.error = originalError;
  }

  const loaded = loadSession(dir);
  assert.equal(loaded.modelName, 'gemini-3.7-flash');
  assert.equal(loaded.activeSessionId, 'session-1');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['session.json'], 'no temp file left behind');
});
