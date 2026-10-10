import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SessionManager } from './session-manager.js';

async function freshDir(tag: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `minus-sess-${tag}-`));
  return dir;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

test('concurrent loads resolve to the same object (identity map, no duplicates)', async () => {
  const dir = await freshDir('load');
  try {
    const writer = new SessionManager(dir);
    const created = await writer.create('shared-load');
    created.append('user/message', { source: 'human', content: { role: 'user', parts: [{ text: 'hi' }] } });
    await writer.save(created);

    const reader = new SessionManager(dir);
    const [a, b] = await Promise.all([reader.load('shared-load'), reader.load('shared-load')]);
    assert.ok(a && b);
    assert.equal(a === b, true);
    assert.equal(reader.get('shared-load') === a, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('concurrent creates with the same id: exactly one wins', async () => {
  const dir = await freshDir('create');
  try {
    const manager = new SessionManager(dir);
    const results = await Promise.allSettled([manager.create('dupe'), manager.create('dupe')]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1);
    assert.equal(failed.length, 1);
    assert.match(String((failed[0] as PromiseRejectedResult).reason?.message || failed[0]), /already exists/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('remove tombstones: load/get empty, late save refused, no zombie file', async () => {
  const dir = await freshDir('tomb');
  try {
    const manager = new SessionManager(dir);
    const holder = await manager.create('doomed');
    assert.equal(await manager.remove('doomed'), true);
    assert.equal(await manager.remove('doomed'), false);
    assert.equal(manager.get('doomed'), undefined);
    assert.equal(await manager.load('doomed'), undefined);
    holder.append('user/message', { source: 'human', content: { role: 'user', parts: [{ text: 'late' }] } });
    await assert.rejects(manager.save(holder), /removed/);
    assert.equal(await fileExists(manager.getPath('doomed')), false);
    await assert.rejects(manager.create('doomed'), /cannot be reused/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('prune tombstones evicted ids and still calls onEvict', async () => {
  const dir = await freshDir('prune');
  try {
    const manager = new SessionManager(dir);
    await manager.create('old-session');
    const evicted: string[] = [];
    const result = await manager.pruneExpiredSessions({ maxAgeMs: -1000, onEvict: (id) => { evicted.push(id); } });
    assert.ok(result.deletedSessionIds.includes('old-session'));
    assert.ok(evicted.includes('old-session'));
    assert.equal(await manager.load('old-session'), undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('setWorkspace starts a fresh epoch (tombstones cleared)', async () => {
  const dirA = await freshDir('ws-a');
  const dirB = await freshDir('ws-b');
  try {
    const manager = new SessionManager(dirA);
    await manager.create('moving');
    await manager.remove('moving');
    manager.setWorkspace(dirB);
    const recreated = await manager.create('moving');
    assert.equal(recreated.id, 'moving');
    assert.equal(await fileExists(manager.getPath('moving')), true);
  } finally {
    await fs.rm(dirA, { recursive: true, force: true });
    await fs.rm(dirB, { recursive: true, force: true });
  }
});
