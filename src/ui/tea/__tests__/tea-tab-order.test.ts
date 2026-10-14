import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRootModel, update } from '../models/root-model.js';
import {
  createComposer,
} from '../models/composer-model.js';
import {
  createDiffViewer,
} from '../models/diff-model.js';
import {
  createSessionTabs,
  formatAnswer,
  modalTabOrder,
  sessionStripClick,
  sessionStripSegments,
  sessionTabsKey,
} from '../models/viewport-model.js';
import { stripTerminalControls } from '../styles/theme.js';
import type { KeyMsg, Msg, RootModel } from '../types.js';

const key = (k: string, text?: string): KeyMsg => ({ type: 'key', key: k, text, now: 10 });
const meta = (data: Record<string, unknown>): Msg =>
  ({ type: 'metadata', data }) as Msg;

function threeTabs() {
  let m = createRootModel({ width: 100, height: 24 });
  [m] = update(meta({ sessions: ['A', 'B', 'C'], sessionIds: ['a', 'b', 'c'], session: 'A', activeSessionId: 'a', model: 'gemini', defaultModel: 'gemini' }), m);
  return m;
}

test('digit keys follow the displayed awaiting-first order, not the raw tab index', () => {
  // Modal đang mở, tab C chờ input nên hiển thị đầu tiên là "1:C" (raw order a, b, c).
  const base = createSessionTabs('a', ['a', 'b', 'c']);
  const tabs = base.tabs.map((t) => (t.id === 'c' ? { ...t, awaitingInput: true } : t));
  const model = {
    focus: 'sessions',
    sessions: { ...base, tabs, open: true },
    viewport: { entries: [], thinking: '', answerStream: '', offset: 0, pinned: true, collapsed: false },
    composer: createComposer(),
    diff: createDiffViewer(),
    sidebar: { tools: [], tokens: 0, model: 'gemini' },
  } as unknown as RootModel;
  assert.deepEqual(modalTabOrder(model.sessions), [2, 0, 1], 'displayed order must be C, A, B');
  const [next] = sessionTabsKey(key('1', '1'), model)!;
  assert.equal(next.sessions.activeId, 'c', 'pressing 1 must switch to displayed-first tab C, not raw index 0 (A)');
});

test('hiding the active tab falls back to the nearest visible tab, not the modal cursor', () => {
  let m = threeTabs(); // viewing A, cursor starts at 0
  [m] = update(key('ctrl+t'), m);
  [m] = update(key('down'), m); // cursor on B, still viewing A
  const [m2] = sessionStripClick(m, { tab: 0, zone: 'close' }); // × on A
  assert.equal(m2.sessions.activeId, 'b', 'must fall back to neighbour B, not cursor tab C');
});

test('setext underline does not fold table rows or indented code into headings', () => {
  const table = stripTerminalControls(formatAnswer('│ a │ b │\n===', 80));
  assert.ok(table.includes('│ a │ b │'), 'table row must survive');
  assert.ok(!table.includes('# │'), 'table row must not become a heading');
  const code = stripTerminalControls(formatAnswer('    const x = 1;\n===', 80));
  assert.ok(code.includes('const x = 1;'), 'indented code must survive');
  assert.ok(!code.includes('# const'), 'indented code must not become a heading');
});

test('narrow strip keeps + new clickable and leaves no dangling separator', () => {
  const state = createSessionTabs('a', ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  const text = sessionStripSegments(state, 40).map((s) => s.text).join('');
  assert.ok(text.includes('+ new'), 'suffix + new must stay clickable');
  assert.ok(!/│ +│/.test(text), 'no doubled orphan separator from shrinking');
});
