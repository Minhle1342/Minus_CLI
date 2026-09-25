import assert from 'node:assert/strict';
import test from 'node:test';
import { Session } from '../session/session.js';
import { collectCompletionObservations, getTurnCompletionState } from './completion-observations.js';

function recordRead(session: Session, id: string, file: string): void {
  session.append('tool/call', { turn: 1, step: 1, toolCallId: id, toolName: 'read_file', args: { path: file } });
  session.append('tool/result', {
    turn: 1, step: 1, toolCallId: id, toolName: 'read_file', result: { success: true, content: 'x' },
  });
}

test('repeated calls reuse the cached pairing until the log grows', () => {
  const session = new Session();
  session.append('turn/start', { turn: 1 });
  recordRead(session, 'c1', 'a.ts');
  const first = collectCompletionObservations(session, 1);
  const second = collectCompletionObservations(session, 1);
  assert.equal(second, first);
  assert.equal(first.length, 1);
  assert.equal(getTurnCompletionState(session, 1).hasMutations, false);

  recordRead(session, 'c2', 'b.ts');
  const third = collectCompletionObservations(session, 1);
  assert.notEqual(third, first);
  assert.equal(third.length, 2);
});

test('unscoped calls are cached separately from turn-scoped calls', () => {
  const session = new Session();
  session.append('turn/start', { turn: 1 });
  recordRead(session, 'c1', 'a.ts');
  const scoped = collectCompletionObservations(session, 1);
  const unscoped = collectCompletionObservations(session);
  assert.equal(unscoped.length, 1);
  assert.notEqual(unscoped, scoped);
});
