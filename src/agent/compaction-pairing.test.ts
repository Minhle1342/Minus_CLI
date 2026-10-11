import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextCompactor } from './context-compactor.js';
import { assertHistoryToolPairing } from '../session/session-invariants.js';

const user = (text: string): any => ({ role: 'user', parts: [{ text }] });
const call = (id: string, name = 'read_file'): any => ({
  role: 'model',
  parts: [{ functionCall: { name, args: { path: 'a.ts' }, id } }],
});
const resp = (id: string, response: unknown = { content: 'file body' }, name = 'read_file'): any => ({
  role: 'user',
  parts: [{ functionResponse: { name, id, response } }],
});
const hasCall = (messages: any[], id: string) =>
  messages.some((m) => (m.parts || []).some((p: any) => p.functionCall?.id === id));
const hasResp = (messages: any[], id: string) =>
  messages.some((m) => (m.parts || []).some((p: any) => p.functionResponse?.id === id));
const hasRecoveredText = (messages: any[]) =>
  messages.some((m) => (m.parts || []).some((p: any) => typeof p.text === 'string' && p.text.includes('RECOVERED UNPAIRED')));

test('rolling compaction carries a background result across the archive cut', () => {
  const history = [
    user('turn one'),
    call('call-a'), resp('call-a'),
    user('turn two'),
    call('call-b'), // background call; result lands two turns later
    user('turn three'),
    user('turn four'),
    resp('call-b'),
  ];
  const out = new ContextCompactor().compact(history as any, {
    force: true,
    preserveLastNTurns: 1,
    enableRollingTurns: true,
  } as any);
  assert.ok(out.messages.length > 0);
  // Healthy pair survives verbatim (carried, not demoted) and stays paired.
  assert.ok(hasCall(out.messages, 'call-b'), 'stranded call carried into preserved tail');
  assert.ok(hasResp(out.messages, 'call-b'), 'late response kept');
  assert.ok(!hasRecoveredText(out.messages), 'healthy pair must not be demoted');
  assertHistoryToolPairing(out.messages as any);
});

test('completed-turn-window compaction unprunes a stranded pair mate', () => {
  const entries = [
    { message: user('t1'), turn: 1 },
    { message: call('call-x'), turn: 1 },
    { message: user('t2'), turn: 2 },
    { message: user('t3'), turn: 3 },
    { message: resp('call-x'), turn: 3 }, // late result in a kept turn
    { message: user('t4 live'), turn: 4 },
  ];
  const out = new ContextCompactor().compactCompletedTurnWindow(entries as any, {
    completedTurns: [1, 2, 3],
    openTurn: 4,
    preserveCompletedTurns: 1,
  });
  assert.ok(hasCall(out.messages, 'call-x'), 'pruned call carried back for its kept response');
  assert.ok(hasResp(out.messages, 'call-x'));
  assertHistoryToolPairing(out.messages as any);
});

test('compact() demotes a damaged-log orphan instead of fatal-erroring the run', () => {
  const history = [user('q'), resp('call-ghost', { content: 'stale output' })];
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (text: string) => { warnings.push(String(text)); };
  try {
    const out = new ContextCompactor().compact(history as any, { force: true } as any);
    assert.ok(warnings.some((w) => w.includes('call-ghost')), 'warning names the demoted id');
    assert.ok(hasRecoveredText(out.messages), 'orphan preserved as marked text');
    assertHistoryToolPairing(out.messages as any);
  } finally {
    console.warn = originalWarn;
  }
});
