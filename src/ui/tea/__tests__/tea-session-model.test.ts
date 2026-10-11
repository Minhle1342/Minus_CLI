import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRootModel, update, view } from '../models/root-model.js';
import { sessionTabsView } from '../models/viewport-model.js';
import { stripTerminalControls } from '../styles/theme.js';
import type { Msg } from '../types.js';

const key = (k: string, text?: string): Msg => ({ type: 'key', key: k, text, now: 10 });
const kernel = (event: string, args: unknown[]): Msg =>
  ({ type: 'kernel', event, args }) as Msg;
const meta = (data: Record<string, unknown>): Msg =>
  ({ type: 'metadata', data }) as Msg;
const plain = (m: ReturnType<typeof createRootModel>) =>
  stripTerminalControls(view(m));

function twoTabs() {
  let m = createRootModel({ width: 100, height: 24 });
  [m] = update(meta({ sessions: ['A', 'B'], sessionIds: ['a', 'b'], session: 'A', activeSessionId: 'a', model: 'gemini', defaultModel: 'gemini' }), m);
  return m;
}

function switchTo(m: ReturnType<typeof createRootModel>, digit: string) {
  [m] = update(key('ctrl+t'), m);
  [m] = update(key(digit, digit), m);
  return m;
}

test('model:changed with ctx pins the owning tab only', () => {
  let m = twoTabs();
  assert.equal(m.sidebar.model, 'gemini');
  [m] = update(kernel('model:changed', ['groq', { sessionId: 'b' }]), m);
  // Viewing A: sidebar untouched, B tab caches groq.
  assert.equal(m.sidebar.model, 'gemini');
  assert.equal(m.sessions.tabs.find((t) => t.id === 'b')!.model, 'groq');
  assert.equal(m.sessions.tabs.find((t) => t.id === 'a')!.model, undefined);
  m = switchTo(m, '2');
  assert.equal(m.sidebar.model, 'groq', 'switching to B shows its model');
  assert.ok(plain(m).includes('groq'), 'statusline shows B model');
  m = switchTo(m, '1');
  assert.equal(m.sidebar.model, 'gemini', 'switching back restores A model');
});

test('ctx-less model:changed updates the default without touching explicit tabs', () => {
  let m = twoTabs();
  [m] = update(kernel('model:changed', ['groq', { sessionId: 'b' }]), m);
  m = switchTo(m, '2');
  assert.equal(m.sidebar.model, 'groq');
  // Global default flips while viewing B (explicit groq): sidebar keeps groq.
  [m] = update(kernel('model:changed', ['gemini']), m);
  assert.equal(m.sessions.defaultModel, 'gemini');
  assert.equal(m.sidebar.model, 'groq', 'explicit tab model wins over default');
  assert.equal(m.sessions.tabs.find((t) => t.id === 'b')!.model, 'groq');
  // Untouched tab A follows the default.
  m = switchTo(m, '1');
  assert.equal(m.sidebar.model, 'gemini', 'untouched tab follows default');
});

test('sessions modal lists each tab model', () => {
  let m = twoTabs();
  [m] = update(kernel('model:changed', ['groq', { sessionId: 'b' }]), m);
  const rows = sessionTabsView(m.sessions, 100, 24).map((l) => stripTerminalControls(l)).join('\n');
  assert.ok(rows.includes('groq'), 'modal shows B model');
  assert.ok(rows.includes('gemini'), 'modal shows default model');
});

test('metadata routes model to the owning tab (adopting kernel-active tab)', () => {
  let m = twoTabs();
  // Kernel still on A while its model flips: only tab A cache + sidebar (viewing A) update.
  [m] = update(meta({ sessions: ['A', 'B'], sessionIds: ['a', 'b'], session: 'A', activeSessionId: 'a', model: 'gemini-pro', defaultModel: 'gemini' }), m);
  assert.equal(m.sidebar.model, 'gemini-pro');
  assert.equal(m.sessions.tabs.find((t) => t.id === 'a')!.model, 'gemini-pro');
  assert.equal(m.sessions.tabs.find((t) => t.id === 'b')!.model, undefined);
  // Kernel moves to B (no optimistic switch in flight): TEA adopts B → sidebar follows B, A cache intact.
  [m] = update(meta({ sessions: ['A', 'B'], sessionIds: ['a', 'b'], session: 'B', activeSessionId: 'b', model: 'groq', defaultModel: 'gemini' }), m);
  assert.equal(m.sessions.activeId, 'b');
  assert.equal(m.sidebar.model, 'groq');
  assert.equal(m.sessions.tabs.find((t) => t.id === 'a')!.model, 'gemini-pro', 'A cache intact after adopting B');
});

test('metadata during optimistic switch does not clobber the new tab display', () => {
  let m = twoTabs();
  m = switchTo(m, '2'); // pendingActiveId = b, kernel still on A
  assert.equal(m.sessions.pendingActiveId, 'b');
  [m] = update(meta({ sessions: ['A', 'B'], sessionIds: ['a', 'b'], session: 'A', activeSessionId: 'a', model: 'gemini', defaultModel: 'gemini' }), m);
  assert.equal(m.sidebar.model, 'gemini', 'viewed B display keeps default (no explicit B model)');
  assert.equal(m.sessions.pendingActiveId, 'b', 'pending switch preserved');
  // Kernel confirms B: pending clears, display follows B.
  [m] = update(meta({ sessions: ['A', 'B'], sessionIds: ['a', 'b'], session: 'B', activeSessionId: 'b', model: 'gemini', defaultModel: 'gemini' }), m);
  assert.equal(m.sessions.pendingActiveId, undefined);
});

test('metadata equal to default never pins the tab (tab keeps following default)', () => {
  let m = twoTabs();
  [m] = update(meta({ sessions: ['A', 'B'], sessionIds: ['a', 'b'], session: 'A', activeSessionId: 'a', model: 'gemini', defaultModel: 'gemini' }), m);
  assert.equal(m.sessions.tabs.find((t) => t.id === 'a')!.model, undefined, 'default-echo must not become explicit');
  assert.equal(m.sidebar.model, 'gemini');
  // Default flips globally: untouched tab A follows it.
  [m] = update(kernel('model:changed', ['groq']), m);
  m = switchTo(m, '2');
  m = switchTo(m, '1');
  assert.equal(m.sidebar.model, 'groq', 'unpinned tab follows new default');
});

test('new tab shows default model, not the previous tab model', () => {
  let m = twoTabs();
  [m] = update(kernel('model:changed', ['groq', { sessionId: 'b' }]), m);
  m = switchTo(m, '2');
  assert.equal(m.sidebar.model, 'groq');
  [m] = update(key('ctrl+t'), m);
  [m] = update(key('n', 'n'), m);
  assert.equal(m.sidebar.model, 'gemini', 'fresh tab follows default, not previous tab');
});

test('metadata activeId flip swaps viewport without overlaying transcripts', () => {
  let m = twoTabs();
  // Live entries on A while viewing A.
  [m] = update({ type: 'log', text: 'work-A-live' }, m);
  assert.ok(plain(m).includes('work-A-live'));
  // Kernel flips active session behind TEA (no optimistic switch in flight).
  [m] = update(meta({ sessions: ['A', 'B'], sessionIds: ['a', 'b'], session: 'B', activeSessionId: 'b', model: 'gemini', defaultModel: 'gemini' }), m);
  assert.equal(m.sessions.activeId, 'b');
  assert.ok(!plain(m).includes('work-A-live'), 'viewport must not keep A transcript after flip');
  // A's live entries were snapshotted, not lost.
  assert.ok((m.sessions.tabs.find((t) => t.id === 'a')!.entries || []).some((e) => e.text.includes('work-A-live')));
  // New live entries land on B only.
  [m] = update({ type: 'log', text: 'work-B-live' }, m);
  const tabA = m.sessions.tabs.find((t) => t.id === 'a')!;
  assert.ok(!(tabA.entries || []).some((e) => e.text.includes('work-B-live')), 'B entries must not leak into A cache');
  assert.ok(plain(m).includes('work-B-live'));
});

test('tool result heading carries no duration (live and hydrate render alike)', () => {
  let m = createRootModel({ width: 100, height: 30 });
  [m] = update(meta({ sessions: ['A'], sessionIds: ['a'], session: 'A', activeSessionId: 'a', model: 'gemini', defaultModel: 'gemini' }), m);
  const ctx = { sessionId: 'a' };
  [m] = update(kernel('tool:after', ['read_file', { content: 'const x = 1;' }, 172, { path: 'a.ts' }, ctx]), m);
  assert.doesNotMatch(m.viewport.entries[0].text, /ms/, 'live heading must not show duration');
  assert.match(m.viewport.entries[0].text, /✔ read_file \[OK\]/);
});

test('session-transcript on a busy tab preserves live streams and background unread', () => {
  let m = twoTabs();
  // Background task on B: streams cached + unread counted.
  [m] = update(kernel('model:token', ['tok-B', { sessionId: 'b' }]), m);
  [m] = update(kernel('tool:before', ['read_file', { path: 'x.ts' }, { sessionId: 'b' }]), m);
  const tabB = () => m.sessions.tabs.find((t) => t.id === 'b')!;
  assert.equal(tabB().answerStream, 'tok-B');
  assert.equal(tabB().unread, 1);
  // Hydrate for background B: cache history but keep streams, keep unread.
  [m] = update({ type: 'session-transcript', sessionId: 'b', entries: [{ kind: 'log', text: 'old-history' }] }, m);
  assert.equal(tabB().answerStream, 'tok-B', 'background stream must survive hydrate');
  assert.equal(tabB().unread, 1, 'background unread must survive hydrate');
  // Switch to B (adopt restores cache incl. stream), then hydrate while viewing + busy.
  m = switchTo(m, '2');
  [m] = update({ type: 'busy', busy: true, sessionId: 'b' }, m);
  [m] = update(kernel('model:token', ['more…', { sessionId: 'b' }]), m);
  [m] = update({ type: 'session-transcript', sessionId: 'b', entries: [{ kind: 'log', text: 'old-history' }] }, m);
  assert.ok((m.viewport.answerStream || '').includes('more…'), 'viewed live stream must survive hydrate');
  assert.ok(m.viewport.entries.some((e) => e.text.includes('old-history')), 'hydrate entries still applied');
});

test('session-transcript hydrate restores the tab model display', () => {
  let m = twoTabs();
  [m] = update(kernel('model:changed', ['groq', { sessionId: 'b' }]), m);
  m = switchTo(m, '2');
  assert.equal(m.sidebar.model, 'groq');
  [m] = update({ type: 'session-transcript', sessionId: 'b', entries: [{ kind: 'log', text: 'old' }] }, m);
  assert.equal(m.sidebar.model, 'groq', 'hydrate keeps owner tab model');
});
