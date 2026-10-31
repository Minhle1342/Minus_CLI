import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRootModel, update, view } from '../models/root-model.js';
import { heuristicGrillOptions, suggestGrillOptions } from '../../../agent/grill-suggest.js';
import { getSlashCommandSuggestions } from '../../cli-ui.js';
import type { Msg } from '../types.js';

const key = (k: string, text?: string): Msg => ({ type: 'key', key: k, text, now: 10 });

test('slash /grill-me is registered with alias /grill', () => {
  const hits = getSlashCommandSuggestions('/grill-me', 5);
  assert.ok(hits.some((h) => h.command === '/grill-me'));
  const alias = getSlashCommandSuggestions('/grill', 5);
  assert.ok(alias.some((h) => h.command === '/grill-me'));
});

test('grill modal opens over input, navigates, picks and cancels', () => {
  let model = createRootModel();
  [model] = update({ type: 'grill', open: true, question: 'Deploy thế nào?', options: heuristicGrillOptions('Deploy thế nào?'), loading: false }, model);
  assert.equal(model.grill.open, true);
  assert.equal(model.focus, 'grill');
  // Phím gõ thường không lọt xuống composer khi modal mở.
  [model] = update(key('a', 'a'), model);
  assert.equal(model.composer.value, '');
  assert.equal(model.grill.open, true);
  // Điều hướng wraps + Enter pick.
  const count = model.grill.options.length;
  [model] = update(key('down'), model);
  assert.equal(model.grill.selected, 1);
  [model] = update(key('1', '1'), model);
  assert.equal(model.grill.open, false);
  // Mở lại rồi Esc hủy.
  [model] = update({ type: 'grill', open: true, question: 'Q', options: heuristicGrillOptions('Q'), loading: false }, model);
  const [cancelled, cancelCmds] = update(key('escape'), model);
  assert.equal(cancelled.grill.open, false);
  assert.deepEqual(cancelCmds, [{ type: 'grill-cancel' }]);
  void count;
});

test('grill overlay replaces rows in view (đè lên input)', () => {
  let model = createRootModel({ width: 60, height: 20 });
  const plain = view(model);
  [model] = update({ type: 'grill', open: true, question: 'Chọn hướng đi?', options: heuristicGrillOptions('Chọn hướng đi?'), loading: false }, model);
  const overlaid = view(model);
  assert.notEqual(overlaid, plain);
  assert.ok(overlaid.includes('GRILL-ME'));
});

test('suggestGrillOptions falls back to heuristic when LLM offline', async () => {
  const { options, fromLLM } = await suggestGrillOptions(undefined, 'Nên dùng Docker hay local?');
  assert.equal(fromLLM, false);
  assert.ok(options.length >= 2);
  const llm = { generate: async () => ({ text: '1. Dùng Docker để cách ly\n2. Dùng local cho nhanh\n3. Hỏi thêm về RAM' }) };
  const live = await suggestGrillOptions(llm, 'Chạy ở đâu?');
  assert.equal(live.fromLLM, true);
  assert.equal(live.options.length, 3);
  assert.ok(live.options.every((o) => o.source === 'llm'));
});

test('suggestGrillOptions passes a real Session carrying the routed sessionId', async () => {
  let seen: any;
  const llm = { generate: async (session: any) => { seen = session; return { text: '1. Phương án A\n2. Phương án B' }; } };
  const live = await suggestGrillOptions(llm, 'Chạy ở đâu?', { sessionId: 'tab-session-7' });
  assert.equal(live.fromLLM, true);
  assert.equal(typeof seen?.getHistory, 'function', 'LLM phải nhận Session thật, không phải object giả');
  assert.equal(seen.id, 'tab-session-7');
  assert.ok(JSON.stringify(seen.getHistory()).includes('Chạy ở đâu?'));
});

test('grill modal supports in-modal custom input for option 4', () => {
  let model = createRootModel({ width: 70, height: 20 });
  const options = [
    { id: '1', label: 'Phương án A', source: 'llm' as const },
    { id: '2', label: 'Phương án B', source: 'llm' as const },
    { id: '3', label: 'Phương án C', source: 'llm' as const },
    { id: 'custom', label: 'Tự nhập phương án khác...', source: 'user' as const },
  ];
  [model] = update({ type: 'grill', open: true, question: 'Lựa chọn kiến trúc?', options, loading: false }, model);
  assert.equal(model.grill.open, true);

  // Chọn mục thứ 4 -> kích hoạt chế độ gõ custom text
  [model] = update(key('4', '4'), model);
  assert.equal(model.grill.open, true);
  assert.equal(model.grill.customInput?.active, true);

  // Gõ văn bản
  [model] = update(key('x', 'x'), model);
  [model] = update(key('y', 'y'), model);
  assert.equal(model.grill.customInput?.value, 'xy');

  // Backspace xóa 1 ký tự
  [model] = update(key('backspace'), model);
  assert.equal(model.grill.customInput?.value, 'x');

  // Esc quay lại danh sách chọn
  [model] = update(key('escape'), model);
  assert.equal(model.grill.customInput?.active, false);

  // Chọn lại mục 4 và gõ text mới rồi Enter submit
  [model] = update(key('4', '4'), model);
  assert.equal(model.grill.customInput?.active, true);
  [model] = update(key('m', 'm'), model);
  [model] = update(key('y', 'y'), model);
  const [submitted, cmds] = update(key('enter'), model);
  assert.equal(submitted.grill.open, false);
  assert.deepEqual(cmds, [{ type: 'grill-pick', text: 'my' }]);
});

test('GrillPlugin registers ask_user tool and SPEC_CLARIFICATION_POLICY', async () => {
  const { GrillPlugin, createAskUserTool, SPEC_CLARIFICATION_POLICY, SPEC_CLARIFICATION_SECTION_ID } = await import('../../../kernel/plugins/grill-plugin.js');
  assert.ok(SPEC_CLARIFICATION_POLICY.includes('SPEC AMBIGUITY'));
  assert.ok(SPEC_CLARIFICATION_POLICY.includes('MULTIPLE VIABLE ARCHITECTURES'));
  assert.ok(SPEC_CLARIFICATION_POLICY.includes('DESTRUCTIVE / IRREVERSIBLE STRATEGY'));
  assert.ok(SPEC_CLARIFICATION_POLICY.includes('ask_user'));

  let registeredSection: any;
  let registeredTool: any;
  let askedQuestion = '';
  let askedContext: any;

  const mockCtx: any = {
    systemPrompt: {
      register(sec: any) { registeredSection = sec; },
      unregister() {},
    },
    registerTool(t: any) { registeredTool = t; },
    grill: {
      async ask(q: string, ctx: any) {
        askedQuestion = q;
        askedContext = ctx;
        return { picked: 'Phương án A' };
      },
    },
  };

  GrillPlugin.apply(mockCtx);
  assert.equal(registeredSection.id, SPEC_CLARIFICATION_SECTION_ID);
  assert.equal(registeredTool.name, 'ask_user');

  // Thực thi tool ask_user
  const tool = createAskUserTool(mockCtx);
  const res = await tool.execute({
    question: 'Chọn hướng đi?',
    options: [
      { label: 'Phương án A', recommended: true },
      { label: 'Phương án B' },
    ],
  }, {} as any);

  assert.equal(askedQuestion, 'Chọn hướng đi?');
  assert.deepEqual(res, { answer: 'Phương án A', cancelled: false });
  assert.equal(askedContext.providedOptions[0].label, '[Đề xuất] Phương án A');
});
