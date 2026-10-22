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

test('câu trả lời tạm thời nằm ngay TRÊN tool call kế tiếp, bọc 2 separator', () => {
  let m = createRootModel({ width: 80, height: 30 });
  [m] = update(kernel('model:token', ['Đây là câu trả lời tạm thời, tôi sẽ kiểm tra thêm file config.']), m);
  [m] = update(kernel('tool:before', ['read_file', { path: 'a.ts' }]), m);
  [m] = update(kernel('tool:after', ['read_file', { success: true, output: 'ok' }, 12, { path: 'a.ts' }]), m);
  [m] = update(kernel('model:token', ['Tiếp tục kiểm tra nữa.']), m);
  [m] = update(kernel('tool:before', ['run_command', { command: 'npm test' }]), m);
  [m] = update(kernel('model:final_answer', ['Đã xong.']), m);

  const kinds = m.viewport.entries.map((e) => e.kind);
  assert.deepEqual(kinds, ['live', 'tool', 'live', 'tool', 'answer'], 'mỗi đoạn text tạm thời nằm ngay trên tool của nó');
  assert.equal(m.viewport.answerStream, '', 'buffer live phải trống sau khi flush');

  // Thứ tự dòng hiển thị: text tạm thời nằm TRÊN tool, có separator bao quanh.
  const lines = plain(m).split('\n').map((l) => l.trim());
  const liveIdx = lines.findIndex((l) => l.includes('Đây là câu trả lời tạm thời'));
  const toolIdx = lines.findIndex((l) => l.includes('read_file'));
  assert.ok(liveIdx >= 0 && toolIdx > liveIdx, 'text tạm thời phải nằm trên dòng tool');
  assert.match(lines[liveIdx - 1], /─{10,}/, 'phải có separator trên đoạn text tạm thời');
  assert.match(lines[liveIdx + 1], /─{10,}/, 'phải có separator dưới đoạn text tạm thời');
  // Final answer giữ nguyên dạng, không bọc separator.
  const answerIdx = lines.findIndex((l) => l.includes('Đã xong'));
  assert.ok(answerIdx > 0 && !/─{10,}/.test(lines[answerIdx - 1]), 'final answer không bị bọc separator');
});

test('click dấu + trước dòng Thinking › mở/tắt riêng khối đó', () => {
  let m = createRootModel({ width: 80, height: 24 });
  [m] = update(kernel('model:thought', ['Dòng 1 của reasoning.\nDòng 2 của reasoning.\nDòng 3 của reasoning.']), m);
  [m] = update(kernel('model:thinking:end', []), m);
  const thought = () => m.viewport.entries.find((e) => e.kind === 'thought')!;

  // Mặc định đóng: có dấu +, nội dung bị ẩn.
  assert.equal(thought().expanded, undefined, 'khối Thinking mặc định đóng');
  const collapsedText = plain(m);
  assert.match(collapsedText, /\+ Thinking › Dòng 1 của reasoning\./);
  assert.ok(!collapsedText.includes('Dòng 3'), 'nội dung sau dòng đầu phải ẩn');

  // Dưới khối Thinking có separator.
  const collapsedRows = collapsedText.split('\n');
  const markerRow = collapsedRows.findIndex((l) => /^\s*\+ Thinking/.test(l));
  assert.match(collapsedRows[markerRow + 1] ?? '', /─{10,}/, 'khối Thinking phải có separator bên dưới');

  // Tìm dòng chứa marker để bấm đúng chỗ.
  const rows = plain(m).split('\n');
  const row = rows.findIndex((l) => /^\s*\+ Thinking/.test(l));
  assert.ok(row >= 0, 'phải tìm thấy dòng có marker');
  const y = row + 1;

  [m] = update({ type: 'key', key: 'mouse+press', now: 10, mouse: { x: 1, y } } as Msg, m);
  assert.equal(thought().expanded, true, 'click vào dấu + phải mở khối Thinking');
  assert.match(plain(m), /− Thinking › /, 'dấu + đổi thành − khi mở');
  assert.ok(plain(m).includes('Dòng 3'), 'mở thì hiện toàn bộ nội dung');

  [m] = update({ type: 'key', key: 'mouse+press', now: 11, mouse: { x: 1, y } } as Msg, m);
  assert.equal(thought().expanded, false, 'click lần hai phải thu gọn lại');
  assert.ok(!plain(m).includes('Dòng 3'), 'thu gọn thì ẩn nội dung lại');
});

test('session-transcript on a busy tab preserves live streams and background unread', () => {
  let m = twoTabs();
  // Background task on B: streams cached + unread counted.
  [m] = update(kernel('model:token', ['tok-B', { sessionId: 'b' }]), m);
  [m] = update(kernel('tool:before', ['read_file', { path: 'x.ts' }, { sessionId: 'b' }]), m);
  const tabB = () => m.sessions.tabs.find((t) => t.id === 'b')!;
  // Tool bắt đầu → text đã stream được flush thành entry 'live' (đứng trên tool),
  // buffer live trống nhưng nội dung vẫn còn trong transcript của tab.
  assert.equal(tabB().answerStream, '', 'text tạm thời phải rời buffer live khi tool bắt đầu');
  assert.ok((tabB().entries || []).some((e) => e.kind === 'live' && e.text.includes('tok-B')), 'text tạm thời phải còn trong transcript');
  assert.equal(tabB().unread, 2, 'live entry + tool entry đều tính unread');
  // Tab B đang chạy task nền (busy) → hydrate chỉ bổ sung cache, không đè transcript.
  [m] = update({ type: 'busy', busy: true, sessionId: 'b' }, m);
  [m] = update({ type: 'session-transcript', sessionId: 'b', entries: [{ kind: 'log', text: 'old-history' }] }, m);
  assert.ok((tabB().entries || []).some((e) => e.kind === 'live' && e.text.includes('tok-B')), 'background live content must survive hydrate');
  assert.equal(tabB().unread, 2, 'background unread must survive hydrate');
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

test('workspace-switch replaces all tabs from old workspace and activates new workspace session', () => {
  let m = twoTabs();
  assert.equal(m.sessions.tabs.length, 2);
  assert.deepEqual(m.sessions.tabs.map((t) => t.id), ['a', 'b']);

  [m] = update({
    type: 'workspace-switch',
    workspace: '/home/user/project-beta',
    activeSessionId: 'sess-beta-1',
    sessionIds: ['sess-beta-1', 'sess-beta-2'],
    titles: ['Task 1', 'Task 2'],
    entries: [{ kind: 'log', text: 'Restored beta history' }],
    model: 'claude-3-5',
    defaultModel: 'gemini',
  }, m);

  // Tabs của workspace cũ phải bị xóa sạch, chỉ còn sessions của workspace mới
  assert.equal(m.sessions.tabs.length, 2);
  assert.deepEqual(m.sessions.tabs.map((t) => t.id), ['sess-beta-1', 'sess-beta-2']);
  assert.equal(m.sessions.activeId, 'sess-beta-1');
  assert.equal(m.sidebar.workspace, '/home/user/project-beta');
  assert.equal(m.viewport.entries.length, 1);
  assert.equal(m.viewport.entries[0].text, 'Restored beta history');
  assert.equal(m.sidebar.model, 'claude-3-5');
  assert.ok(m.status.notice?.includes('project-beta'));
});

test('workspace-switch to empty workspace initializes single active tab with no leak', () => {
  let m = twoTabs();
  [m] = update({
    type: 'workspace-switch',
    workspace: '/home/user/brand-new-ws',
    activeSessionId: 'sess-new-1',
    sessionIds: [],
    entries: [],
  }, m);

  // Workspace mới tinh chưa có session nào lưu: chỉ có 1 tab active duy nhất, không leak tabs cũ
  assert.equal(m.sessions.tabs.length, 1);
  assert.equal(m.sessions.tabs[0].id, 'sess-new-1');
  assert.equal(m.sessions.activeId, 'sess-new-1');
  assert.equal(m.sidebar.workspace, '/home/user/brand-new-ws');
  assert.equal(m.viewport.entries.length, 0);
  assert.equal(m.viewport.thinking, '');
  assert.equal(m.viewport.answerStream, '');
});

test('session awaiting input is prioritized and pinned in tab strip and sessions modal', () => {
  let m = twoTabs(); // tabs: 'a', 'b'. activeId: 'a'
  // Tab 'b' nhận question (permission / user input prompt)
  [m] = update({
    type: 'question',
    prompt: 'Allow deleting database?',
    active: true,
    sessionId: 'b',
  }, m);

  // Tab b được đánh dấu awaitingInput = true
  const tabB = m.sessions.tabs.find((t) => t.id === 'b');
  assert.equal(tabB?.awaitingInput, true);

  // Trong strip view: tab 'b' có biểu tượng tia chớp / ? và được sort lên trước
  const strip = plain(m);
  assert.ok(strip.includes('⚡') || strip.includes('?'), 'tab strip indicates awaiting input');

  // Trong sessions modal: tab 'b' có nhãn CHỜ INPUT
  const rows = sessionTabsView(m.sessions, 100, 24).map((l) => stripTerminalControls(l)).join('\n');
  assert.ok(rows.includes('[CHỜ INPUT]'), 'modal displays awaiting input badge');
  assert.ok(rows.includes('1 chờ input'), 'modal summary reflects awaiting input count');
  // First item listed in modal should be tab 'b'
  const firstItemLine = rows.split('\n').find((l) => l.includes('1.'));
  assert.ok(firstItemLine?.includes('B'), 'tab B is sorted to top of modal');

  // Khi question kết thúc (active: false)
  [m] = update({
    type: 'question',
    prompt: '',
    active: false,
    sessionId: 'b',
  }, m);
  const tabBAfter = m.sessions.tabs.find((t) => t.id === 'b');
  assert.equal(tabBAfter?.awaitingInput, false);
});

