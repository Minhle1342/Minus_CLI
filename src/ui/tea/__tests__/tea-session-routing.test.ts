import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRootModel, update, view } from '../models/root-model.js';
import { stripTerminalControls } from '../styles/theme.js';
import type { Msg } from '../types.js';

const key = (k: string, text?: string): Msg => ({ type: 'key', key: k, text, now: 10 });
const kernel = (event: string, args: unknown[]): Msg =>
  ({ type: 'kernel', event, args }) as Msg;
const meta = (ids: string[], names: string[], actId: string, actName: string): Msg =>
  ({ type: 'metadata', data: { sessions: names, sessionIds: ids, session: actName, activeSessionId: actId } });
const plain = (m: ReturnType<typeof createRootModel>) =>
  stripTerminalControls(view(m));

function twoTabs() {
  let m = createRootModel({ width: 100, height: 24 });
  [m] = update(meta(['a', 'b'], ['A', 'B'], 'a', 'A'), m);
  [m] = update({ type: 'log', text: 'work-A' }, m);
  return m;
}

test('tool events with background ctx do not leak into viewed viewport', () => {
  let m = twoTabs();
  // Task của A bắt đầu (pin) rồi user sang B — kernel vẫn emit ctx A.
  [m] = update({ type: 'busy', busy: true }, m);
  [m] = update(key('ctrl+t'), m);
  [m] = update(key('2', '2'), m);
  assert.equal(m.sessions.activeId, 'b');
  [m] = update(kernel('tool:before', ['read_file', { path: 'x.ts' }, { sessionId: 'a' }]), m);
  [m] = update(kernel('tool:after', ['read_file', { output: 'DATA-A' }, 12, { path: 'x.ts' }, { sessionId: 'a' }]), m);
  const bView = plain(m);
  assert.ok(!bView.includes('DATA-A'), 'viewport B phải sạch tool-entry của A');
  assert.ok(!bView.includes('read_file'), 'viewport B không thấy tên tool của A');
  const tabA = m.sessions.tabs.find((t) => t.id === 'a')!;
  assert.equal(tabA.entries?.length, 2); // work-A (snapshot lúc switch) + merged tool entry (call+result gộp 1 dòng)
  assert.equal(tabA.unread, 1); // tool:before tăng 1; merged replace không tăng lại
  // Quay lại A thấy đủ tool boxes, unread clear.
  [m] = update(key('ctrl+t'), m);
  [m] = update(key('1', '1'), m);
  const aView = plain(m);
  assert.ok(aView.includes('DATA-A') && aView.includes('read_file'));
  assert.equal(m.sessions.tabs.find((t) => t.id === 'a')!.unread, 0);
});

test('orphan tool:after on a background tab keeps the result row', () => {
  let m = twoTabs();
  [m] = update(key('ctrl+t'), m);
  [m] = update(key('2', '2'), m);
  assert.equal(m.sessions.activeId, 'b');
  // No matching tool:before for A — a replayed/partial event stream.
  [m] = update(kernel('tool:after', ['read_file', { output: 'ORPHAN-A' }, 7, { path: 'x.ts' }, { sessionId: 'a' }]), m);
  const tabA = m.sessions.tabs.find((t) => t.id === 'a')!;
  assert.equal(tabA.entries?.length, 2); // work-A + result row
  assert.ok(tabA.entries?.[1].text.includes('ORPHAN-A'));
  assert.ok(!plain(m).includes('ORPHAN-A'), 'result must stay out of viewport B');
});

test('busy tracks per session with parallel tasks', () => {
  let m = twoTabs();
  [m] = update({ type: 'busy', busy: true, sessionId: 'a' }, m);
  assert.equal(m.sessions.tabs.find((t) => t.id === 'a')!.busy, true);
  assert.equal(m.status.busy, true);
  // Task B starts while A still runs — both dots on, global stays on.
  [m] = update({ type: 'busy', busy: true, sessionId: 'b' }, m);
  assert.equal(m.sessions.tabs.find((t) => t.id === 'b')!.busy, true);
  assert.equal(m.status.busy, true);
  // A finishes first: only A dot off, B keeps running, pin re-points to B.
  [m] = update({ type: 'busy', busy: false, sessionId: 'a' }, m);
  assert.equal(m.sessions.tabs.find((t) => t.id === 'a')!.busy, false);
  assert.equal(m.sessions.tabs.find((t) => t.id === 'b')!.busy, true);
  assert.equal(m.status.busy, true);
  assert.equal(m.status.busySessionId, 'b');
  // B finishes: all off, unpinned.
  [m] = update({ type: 'busy', busy: false, sessionId: 'b' }, m);
  assert.equal(m.status.busy, false);
  assert.equal(m.status.busySessionId, undefined);
});

test('legacy busy without sessionId falls back to viewed tab', () => {
  let m = twoTabs();
  [m] = update({ type: 'busy', busy: true }, m);
  assert.equal(m.sessions.tabs.find((t) => t.id === 'a')!.busy, true);
  assert.equal(m.status.busySessionId, 'a');
  [m] = update({ type: 'busy', busy: false }, m);
  assert.equal(m.status.busy, false);
  assert.equal(m.status.busySessionId, undefined);
});

test('explicit ctx wins over busy pin (parallel tasks)', () => {
  let m = twoTabs();
  [m] = update({ type: 'busy', busy: true }, m); // pin A, đang xem A
  // Event mang ctx B → vào buffer B dù pin là A, viewport A sạch.
  [m] = update(kernel('model:token', ['tok-B ', { sessionId: 'b' }]), m);
  assert.ok(!plain(m).includes('tok-B'), 'token ctx B không lọt viewport A');
  assert.equal(m.sessions.tabs.find((t) => t.id === 'b')!.answerStream, 'tok-B ');
});

test('final_answer with ctx flushes the correct tab buffer; missing ctx falls back to pin', () => {
  let m = twoTabs();
  [m] = update({ type: 'busy', busy: true }, m);
  [m] = update(key('ctrl+t'), m);
  [m] = update(key('2', '2'), m); // sang B, task A chạy nền
  [m] = update(kernel('model:thought', ['reason-A']), m);
  [m] = update(kernel('model:token', ['ans-A']), m);
  // thought/token không ctx → rớt về pin (A) — hành vi legacy giữ nguyên.
  const tabA1 = m.sessions.tabs.find((t) => t.id === 'a')!;
  assert.equal(tabA1.thinking, 'reason-A');
  assert.equal(tabA1.answerStream, 'ans-A');
  [m] = update(kernel('model:final_answer', ['DONE-A', { sessionId: 'a' }]), m);
  const tabA2 = m.sessions.tabs.find((t) => t.id === 'a')!;
  assert.equal(tabA2.answerStream, '');
  assert.equal(tabA2.thinking, '');
  const kinds = (tabA2.entries || []).map((e) => e.kind);
  assert.ok(kinds.includes('thought') && kinds.includes('answer'));
  assert.ok(!plain(m).includes('DONE-A'), 'viewport B không thấy answer của A');
});
