import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRootModel, update } from '../models/root-model.js';
import type { Msg } from '../types.js';

const kernel = (event: string, args: unknown[]): Msg => ({ type: 'kernel', event, args }) as Msg;
const key = (k: string): Msg => ({ type: 'key', key: k, now: 10 });

const SPAWN = kernel('agent/status', [{
  id: 'subagent-1', status: 'running', sessionId: 'session-sub-1', name: 'Subagent: fix auth', isSubagent: true,
}]);

test('subagent có tab riêng; transcript của nó không lẫn vào viewport agent cha', () => {
  let m = createRootModel({ width: 100, height: 24 });
  [m] = update(SPAWN, m);

  const tab = m.sessions.tabs.find(t => t.id === 'session-sub-1');
  assert.ok(tab, 'tab subagent phải được tạo');
  assert.equal(tab?.subagent, true);
  assert.equal(tab?.busy, true);
  assert.match(String(tab?.title), /fix auth/);

  [m] = update(kernel('tool:before', ['read_file', { path: 'x.ts' }, { sessionId: 'session-sub-1', isSubagent: true }]), m);
  assert.ok(!m.viewport.entries.some(e => e.text.includes('read_file')), 'tool của subagent không được lọt vào viewport cha');
  assert.ok(m.sessions.tabs.find(t => t.id === 'session-sub-1')?.entries?.length, 'tool của subagent nằm trong tab con');

  // Metadata refresh định kỳ không được xoá tab subagent (nó không phải session của kernel).
  [m] = update({ type: 'metadata', data: { sessions: ['Main'], sessionIds: ['main'], activeSessionId: 'main' } }, m);
  assert.ok(m.sessions.tabs.some(t => t.id === 'session-sub-1'), 'tab subagent sống sót qua metadata sync');
});

test('stdout của subagent (dòng log) rơi vào tab con, không vào viewport cha', () => {
  let m = createRootModel({ width: 100, height: 24 });
  [m] = update(SPAWN, m);
  [m] = update({ type: 'log', text: '● search_text "src/a.ts" ✔ 12 matches', sessionId: 'session-sub-1' }, m);
  assert.ok(!m.viewport.entries.some(e => e.text.includes('search_text')), 'log của subagent không lọt vào viewport cha');
  assert.ok(m.sessions.tabs.find(t => t.id === 'session-sub-1')?.entries?.some(e => e.text.includes('search_text')), 'log nằm ở tab con');
});

test('tab subagent chỉ để xem: không switch session kernel, không gửi prompt', () => {
  let m = createRootModel({ width: 100, height: 24 });
  [m] = update(SPAWN, m);
  [m] = update({ type: 'metadata', data: { sessions: ['Main'], sessionIds: ['main'], activeSessionId: 'main' } }, m);

  [m] = update(key('ctrl+t'), m);
  [m] = update(key('down'), m);
  const [switched, cmds] = update(key('enter'), m);
  assert.equal(switched.sessions.activeId, 'session-sub-1', 'đang xem tab subagent');
  assert.ok(!cmds.some(c => c.type === 'session-switch'), 'tab subagent không phải session của kernel → không switch');

  const [typed] = update({ type: 'compose', text: 'hello' }, switched);
  const [after, cmds2] = update(key('enter'), typed);
  assert.ok(!cmds2.some(c => c.type === 'submit'), 'không gửi prompt khi đang ở tab subagent');
  assert.match(String(after.status.notice), /chỉ để xem/);
});
