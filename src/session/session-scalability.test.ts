import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Session } from './session.js';
import { SessionPersistence } from './session-persistence.js';

function buildTurn(session: Session, turn: number, withHeader = false): void {
  session.append('turn/start', { turn });
  session.append('step/start', { turn, step: 1 });
  session.append('tool/call', { turn, step: 1, toolName: 'read_file', toolCallId: `call-${turn}`, args: { path: 'a.ts' } });
  session.append('tool/result', { turn, step: 1, toolCallId: `call-${turn}`, toolName: 'read_file', result: { content: 'x' } });
  if (withHeader) {
    session.recordRequestHeader(
      { turn, step: 1, systemPrompt: 'p', tools: [], history: session.getHistory() } as any,
      { compactHistory: true },
    );
  }
  session.append('step/end', { turn, step: 1 });
  session.append('turn/end', { turn, reason: 'completed' });
}

test('incremental invariants match full scan and catch late violations', () => {
  const session = new Session('session-incremental');
  buildTurn(session, 1, true);
  session.assertRuntimeInvariantsIncremental({ allowOpenLifecycle: true, verifyRequestReplay: 'latest' });
  session.append('turn/start', { turn: 2 });
  session.append('step/start', { turn: 2, step: 1 });
  session.append('tool/call', { turn: 2, step: 1, toolName: 'read_file', toolCallId: 'call-2', args: { path: 'b.ts' } });
  session.append('tool/result', { turn: 2, step: 1, toolCallId: 'call-2', toolName: 'read_file', result: { content: 'y' } });
  session.recordRequestHeader(
    { turn: 2, step: 1, systemPrompt: 'p', tools: [], history: session.getHistory() } as any,
    { compactHistory: true },
  );
  // Second call must only verify the delta and still pass.
  session.assertRuntimeInvariantsIncremental({ allowOpenLifecycle: true, verifyRequestReplay: 'latest' });
  // Full scan agrees.
  session.assertRuntimeInvariants({ allowOpenLifecycle: true, verifyRequestReplay: 'latest' });

  session.append('tool/call', { turn: 2, step: 1, toolName: 'read_file', toolCallId: 'call-2', args: {} });
  assert.throws(
    () => session.assertRuntimeInvariantsIncremental({ allowOpenLifecycle: true }),
    /duplicate tool\/call id/,
  );
});

test('recordRequestHeader keeps digest replay compatible without JSON alloc', () => {
  const session = new Session('session-header-chars');
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  session.addUserMessage('hi');
  const event = session.recordRequestHeader(
    { turn: 1, step: 1, systemPrompt: 'p', tools: [], history: session.getHistory() } as any,
    { compactHistory: true },
  );
  const header = (event.data as any).requestHeader;
  assert.ok(typeof header.historyDigest === 'string');
  assert.ok(typeof header.historyCharacters === 'number' && header.historyCharacters > 0);
  // Self-written header: replay is skipped by construction, still passes.
  session.assertRuntimeInvariantsIncremental({ allowOpenLifecycle: true, verifyRequestReplay: 'latest' });
});

test('recordRequestHeader omits unchanged prompt and tools and still replays', () => {
  const session = new Session('session-header-dedupe');
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  const base = { turn: 1, systemPrompt: 'prompt', tools: [{ name: 'a' }], history: [] };
  const first = session.recordRequestHeader({ ...base, step: 1 } as any, { compactHistory: true });
  session.append('step/end', { turn: 1, step: 1 });
  session.append('step/start', { turn: 1, step: 2 });
  const second = session.recordRequestHeader({ ...base, step: 2 } as any, { compactHistory: true });
  assert.equal((first.data as any).requestHeader.systemPrompt, 'prompt');
  assert.equal((second.data as any).requestHeader.systemPrompt, undefined);
  assert.equal((second.data as any).requestHeader.tools, undefined);
  assert.equal((second.data as any).requestHeader.toolsDigest, (first.data as any).requestHeader.toolsDigest);

  const loaded = Session.fromSnapshot(JSON.parse(JSON.stringify(session.toSnapshot())));
  assert.doesNotThrow(() => loaded.assertRuntimeInvariants({ allowOpenLifecycle: true, verifyRequestReplay: 'all' }));
});

test('tool results are projected without a duplicated content payload', () => {
  const session = new Session('session-tool-result');
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('assistant/message', {
    content: { role: 'model', parts: [{ functionCall: { name: 'read_file', args: {}, id: 'c1' } }] },
  });
  session.append('tool/call', { turn: 1, step: 1, toolName: 'read_file', toolCallId: 'c1', assistantSeq: 3, args: {} });
  session.addToolResultWithId('read_file', { success: true, content: 'x' }, 'c1');

  assert.equal(session.getEvents().find((e) => e.type === 'tool/result')?.data.content, undefined);
  const response = session.getHistory().at(-1)?.parts?.[0]?.functionResponse;
  assert.equal(response?.id, 'c1');
  assert.deepEqual(response?.response, { success: true, content: 'x' });
});

test('load rewrites superseded compaction snapshots out of the JSONL', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-session-compaction-'));
  try {
    const persistence = new SessionPersistence(root);
    const filePath = persistence.getSessionPath('session-compactions');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // Legacy file: every compaction kept its full snapshot on disk.
    const createdAt = '2026-01-01T00:00:00.000Z';
    const header = { kind: 'session', version: 1, id: 'session-compactions', createdAt };
    const text = (value: string) => ({ role: 'user', parts: [{ text: value }] });
    const events = ['one', 'two', 'three'].map((value, index) => ({
      seq: index + 1,
      id: `session-compactions:${index + 1}`,
      type: 'session/compaction',
      createdAt,
      data: { messages: [text(value)], reason: 'context-compaction' },
    }));
    await fs.writeFile(filePath, `${[header, ...events].map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
    const sizeBefore = (await fs.stat(filePath)).size;

    const loaded = await persistence.load('session-compactions');
    const compactions = loaded!.getEvents().filter((e) => e.type === 'session/compaction');
    assert.deepEqual(compactions.map((e) => e.seq), [1, 2, 3]);
    assert.equal(compactions[0].data.messages, undefined);
    assert.equal(compactions[0].data.messagesStripped, true);
    assert.equal(compactions[2].data.messages?.[0].parts?.[0].text, 'three');
    assert.deepEqual(loaded!.getHistory().map((m) => m.parts?.[0].text), ['three']);

    // The rewrite removes the superseded payloads from disk while keeping the
    // header and every sequence number.
    const raw = await fs.readFile(filePath, 'utf8');
    assert.ok((await fs.stat(filePath)).size < sizeBefore, 'rewritten file is smaller');
    assert.ok(!raw.includes('"one"') && !raw.includes('"two"'), 'old snapshots are gone');
    assert.ok(raw.includes('"three"'), 'newest snapshot survives');
    assert.deepEqual(raw.trim().split('\n').slice(1).map((line) => JSON.parse(line).seq), [1, 2, 3]);

    // A later save appends from the rewritten size without a gap (a diverged
    // offset would have thrown); reload adds crash-recovery closure events.
    loaded!.append('turn/start', { turn: 1 });
    await persistence.save(loaded!);
    assert.ok((await persistence.load('session-compactions'))!.seq >= 4);
  } finally {
    await fs.rm(path.join(root, '.codingagent'), { recursive: true, force: true }).catch(() => {});
  }
});

test('findLatestEventOfType scans without cloning the log', () => {
  const session = new Session('session-find-latest');
  buildTurn(session, 1);
  session.append('session/compaction', { messages: [], reason: 'test', compactionState: { marker: 1 } });
  buildTurn(session, 2);
  const found = session.findLatestEventOfType('session/compaction');
  assert.equal((found?.data as any)?.compactionState?.marker, 1);
  assert.equal(session.findLatestEventOfType('turn/end')?.data.reason, 'completed');
  assert.equal(session.findLatestEventOfType('plan/change' as any), undefined);
});

test('getModelName returns the latest model/change event', () => {
  const session = new Session('session-model-name');
  assert.equal(session.getModelName(), undefined);
  session.append('model/change', { modelName: 'gemini' });
  session.append('turn/start', { turn: 1 });
  session.append('model/change', { modelName: 'groq' });
  assert.equal(session.getModelName(), 'groq');
});

test('getEventsAfter filters by seq, never by log index', () => {
  const session = new Session('session-seq-filter');
  buildTurn(session, 1);
  const after = session.getEventsAfter(2);
  assert.deepEqual(after.map((e) => e.seq), [3, 4, 5, 6]);
});

test('save fails loud on diverged logs instead of corrupting the file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-session-diverged-'));
  try {
    const persistence = new SessionPersistence(root);
    // Case A: memory shorter than cursor (stale session object) → ahead guard.
    const stale = new Session('session-diverged');
    buildTurn(stale, 1);
    await persistence.save(stale);
    (stale as any).eventLog.splice(1, 2);
    await assert.rejects(persistence.save(stale), /ahead of in-memory session/);
    // Case B: suffix no longer resumes the file → resume guard (no write happens).
    const suffix = new Session('session-diverged-suffix');
    buildTurn(suffix, 1);
    await persistence.save(suffix);
    (suffix as any).eventLog[2].seq = 60;
    suffix.append('turn/start', { turn: 99 });
    await assert.rejects(persistence.save(suffix), /Refusing to persist session/);
    const reloaded = await persistence.load('session-diverged-suffix');
    assert.equal(reloaded?.seq, 6);
  } finally {
    await fs.rm(path.join(root, '.codingagent'), { recursive: true, force: true }).catch(() => {});
  }
});

test('loadOrQuarantine preserves corrupt files aside and loads healthy ones', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-session-quarantine-'));
  try {
    const persistence = new SessionPersistence(root);
    const healthy = new Session('session-healthy');
    healthy.append('turn/start', { turn: 1 });
    await persistence.save(healthy);

    // Craft a gapped file like session-mv231wow9fff (missing middle seqs).
    const victim = new Session('session-gapped');
    buildTurn(victim, 1);
    buildTurn(victim, 2);
    await persistence.save(victim);
    const victimPath = persistence.getSessionPath('session-gapped');
    const raw = (await fs.readFile(victimPath, 'utf8')).split('\n').filter(Boolean);
    await fs.writeFile(victimPath, [raw[0], ...raw.slice(4)].join('\n') + '\n');

    const loaded = await persistence.loadOrQuarantine('session-gapped');
    assert.equal(loaded, undefined);
    assert.equal(await persistence.load('session-healthy').then((s) => s?.id), 'session-healthy');
    const dir = await fs.readdir(path.dirname(victimPath));
    assert.ok(dir.some((f) => f.startsWith('session-gapped.jsonl.corrupt-')), 'corrupt file renamed aside, never deleted');
    assert.ok(!dir.includes('session-gapped.jsonl'), 'original path cleared');

    // Unknown errors still throw; missing files still return undefined.
    assert.equal(await persistence.loadOrQuarantine('session-missing'), undefined);
  } finally {
    await fs.rm(path.join(root, '.codingagent'), { recursive: true, force: true }).catch(() => {});
  }
});

test('persistence prunes by tail read and finds interrupted sessions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-session-persist-'));
  try {
    const persistence = new SessionPersistence(root);
    const oldSession = new Session('session-old');
    oldSession.append('turn/start', { turn: 1 });
    oldSession.addUserMessage('old work');
    await persistence.save(oldSession);
    const active = new Session('session-active');
    active.append('turn/start', { turn: 1 });
    active.addUserMessage('active work');
    await persistence.save(active);

    // Backdate the old session file beyond retention.
    const oldPath = persistence.getSessionPath('session-old');
    const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await fs.utimes(oldPath, ancient, ancient);

    const found = await persistence.findLatestInterruptedSession();
    assert.ok(found, 'interrupted turn must be detected without full parses');
    assert.ok(['session-old', 'session-active'].includes(found!.sessionId));

    const pruned = await persistence.pruneExpiredSessions({ maxAgeMs: -1000, activeSessionId: 'session-active' });
    assert.ok(pruned.deletedSessionIds.includes('session-old'));
    assert.ok(pruned.preservedSessionIds.includes('session-active'));

    const reloaded = await persistence.load('session-active');
    assert.equal(reloaded?.id, 'session-active');
    assert.ok((reloaded?.seq || 0) > 0);
  } finally {
    await fs.rm(path.join(root, '.codingagent'), { recursive: true, force: true }).catch(() => {});
  }
});
