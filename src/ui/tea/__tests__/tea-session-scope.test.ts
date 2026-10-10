import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRootModel, update, view } from '../models/root-model.js';
import { stripTerminalControls } from '../styles/theme.js';
import type { Msg } from '../types.js';

const key = (k: string, text?: string, mouse?: { x: number; y: number }): Msg =>
  ({ type: 'key', key: k, text, mouse, now: 10 });
const kernel = (event: string, args: unknown[]): Msg =>
  ({ type: 'kernel', event, args }) as Msg;
const meta = (ids: string[], names: string[], actId: string, actName: string): Msg =>
  ({ type: 'metadata', data: { sessions: names, sessionIds: ids, session: actName, activeSessionId: actId } });
const plain = (m: ReturnType<typeof createRootModel>) =>
  stripTerminalControls(view(m));

function twoTabs() {
  let m = createRootModel({ width: 100, height: 24 });
  [m] = update(meta(['a', 'b'], ['A', 'B'], 'a', 'A'), m);
  return m;
}

function typeText(m: ReturnType<typeof createRootModel>, text: string) {
  for (const ch of text) {
    [m] = update(key(ch.toLowerCase(), ch), m);
  }
  return m;
}

function switchTo(m: ReturnType<typeof createRootModel>, digit: string) {
  [m] = update(key('ctrl+t'), m);
  [m] = update(key(digit, digit), m);
  return m;
}

test('composer draft/cursor/history follow the selected tab', () => {
  let m = twoTabs();
  m = typeText(m, 'draft-a');
  [m] = update(key('left'), m); // cursor 6
  assert.equal(m.composer.value, 'draft-a');
  assert.equal(m.composer.cursorOffset, 6);
  m = switchTo(m, '2');
  assert.equal(m.composer.value, '', 'tab B starts with fresh input');
  m = typeText(m, 'draft-b');
  m = switchTo(m, '1');
  assert.equal(m.composer.value, 'draft-a', 'draft A restored');
  assert.equal(m.composer.cursorOffset, 6, 'cursor A restored');
  // Submit in A, history stays per-tab.
  [m] = update(key('enter'), m);
  assert.deepEqual(m.composer.history, ['draft-a']);
  m = switchTo(m, '2');
  [m] = update(key('up'), m);
  assert.equal(m.composer.value, 'draft-b', 'B has no history to recall, keeps its draft');
  m = switchTo(m, '1');
  [m] = update(key('up'), m);
  assert.equal(m.composer.value, 'draft-a', 'A recalls its own submission');
});

test('diff + tools + tokens follow the owning tab, not the viewed one', () => {
  let m = twoTabs();
  [m] = update({ type: 'busy', busy: true }, m);
  m = switchTo(m, '2'); // xem B, task A chạy nền (pin A)
  const diffText = '--- x\n+++ x\n@@ -1 +1 @@\n-a\n+b';
  [m] = update(kernel('tool:before', ['write_file', { path: 'x' }]), m); // no ctx → pin A
  [m] = update(kernel('tool:after', ['write_file', { output: 'ok', diff: diffText }, 9, { path: 'x' }]), m);
  [m] = update(kernel('model:usage', [{ promptTokens: 11, totalTokens: 22 }]), m);
  assert.deepEqual(m.sidebar.tools, [], 'viewed sidebar shows no background tools');
  assert.equal(m.sidebar.tokens, 0, 'viewed tokens untouched');
  assert.equal(m.diff.text, '', 'viewed diff untouched');
  const tabA = m.sessions.tabs.find((t) => t.id === 'a')!;
  assert.deepEqual(tabA.tools, [], 'tool finished → removed from owner tab too');
  assert.equal(tabA.tokens, 11, 'usage routed to owner tab (promptTokens preferred)');
  assert.equal(tabA.diff?.text, diffText, 'diff stored on owner tab');
  // Quay lại A thấy diff + tokens của A.
  m = switchTo(m, '1');
  assert.equal(m.diff.text, diffText);
  assert.equal(m.sidebar.tokens, 11);
  [m] = update({ type: 'action', action: 'diff' }, m);
  assert.ok(plain(m).includes('Diff ·'), 'diff viewer renders for the selected tab');
});

test('permission card + draft follow the owning session, not the viewed tab', () => {
  let m = twoTabs();
  m = typeText(m, 'keep-me');
  // Permission của task B bật lên trong lúc đang xem A.
  [m] = update({ type: 'question', prompt: 'Allow?', active: true, permission: { toolName: 't', target: 'x', summary: 's', riskLevel: 'LOW', category: 'c' }, sessionId: 'b' } as Msg, m);
  assert.equal(m.composer.value, 'keep-me', 'viewed composer not wiped by foreign question');
  assert.ok(!plain(m).includes('Permission request'), 'no foreign card in viewed viewport');
  const tabB = m.sessions.tabs.find((t) => t.id === 'b')!;
  assert.ok((tabB.entries || []).some((e) => e.kind === 'permission'), 'card cached on owner tab');
  // Đóng question → draft stash về tab B, composer A nguyên vẹn.
  [m] = update({ type: 'question', prompt: '', active: false } as Msg, m);
  assert.equal(m.composer.value, 'keep-me');
  assert.equal(m.sessions.tabs.find((t) => t.id === 'b')!.composer?.value, 'keep-me');
});
