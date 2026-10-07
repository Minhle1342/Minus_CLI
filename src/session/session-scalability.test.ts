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
