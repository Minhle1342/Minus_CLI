import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Session } from './session.js';
import { SessionPersistence } from './session-persistence.js';

async function tempWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minus-session-'));
}

test('a torn final line is dropped instead of blocking startup', async () => {
  const dir = await tempWorkspace();
  const persistence = new SessionPersistence(dir);
  const session = new Session();
  await persistence.save(session);
  await fs.appendFile(persistence.getSessionPath(session.id), '{"seq":1,"type":"user/message","data":{', 'utf8');

  const loaded = await persistence.loadOrQuarantine(session.id);

  assert.ok(loaded, 'a torn write must not throw');
  assert.equal(loaded.seq, 0, 'the incomplete event was never persisted');
});

test('a corrupt event line is quarantined, not fatal', async () => {
  const dir = await tempWorkspace();
  const persistence = new SessionPersistence(dir);
  const session = new Session();
  session.append('turn/start', { turn: 1 });
  await persistence.save(session);

  const file = persistence.getSessionPath(session.id);
  const raw = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, raw.replace('"turn/start"', 'NOT_JSON'), 'utf8');

  const loaded = await persistence.loadOrQuarantine(session.id);

  assert.equal(loaded, undefined);
  const files = await fs.readdir(persistence.sessionsDir);
  assert.ok(files.some((name) => name.includes('.corrupt-')), 'original file must be preserved');
});
