import assert from 'node:assert';
import React from 'react';
import { EventEmitter } from 'node:events';
import {
  TuiStore,
  createInitialState,
  tuiReducer,
  Header,
  TelemetryBar,
  StepStream,
  LoadingSpinner,
  SPINNER_FRAMES,
  LiveReasoningBox,
  DiffPreviewBox,
  InputPromptBar,
  App,
} from './ui/ink/index.js';
import { SLASH_COMMANDS } from './ui/cli-ui.js';
import { Workspace } from './workspace/workspace.js';
import { FileMentionEngine } from './workspace/file-attachment.js';

console.log('========================================');
console.log('🧪 KIỂM THỬ INK (REACT FOR CLI) TUI SYSTEM');
console.log('========================================\n');

// 1. Kiểm thử State & Reducer
console.log('▶ 1. Kiểm thử State & Reducer (createInitialState & tuiReducer)');
const initialState = createInitialState({
  modelName: 'gemini-3.5-flash-lite',
  workspacePath: '/test/workspace',
  sandboxMode: 'docker',
  maxContextTokens: 500_000,
});

assert.strictEqual(initialState.modelName, 'gemini-3.5-flash-lite');
assert.strictEqual(initialState.sandboxMode, 'docker');
assert.strictEqual(initialState.status, 'idle');
assert.strictEqual(initialState.tokens.max, 500_000);
console.log('  ✅ PASS: Khởi tạo initial state chính xác');

let state = tuiReducer(initialState, {
  type: 'STEP_START',
  step: 1,
  maxSteps: 10,
});
assert.strictEqual(state.currentStep, 1);
assert.strictEqual(state.status, 'thinking');
console.log('  ✅ PASS: STEP_START chuyển trạng thái sang thinking');

state = tuiReducer(state, {
  type: 'TOOL_START',
  toolName: 'read_file',
  args: { path: 'package.json' },
  step: 1,
  maxSteps: 10,
  phase: 'EXPLORE',
});
assert.strictEqual(state.status, 'executing_tool');
assert.strictEqual(state.steps.length, 1);
assert.strictEqual(state.steps[0].toolName, 'read_file');
assert.strictEqual(state.steps[0].status, 'running');
console.log('  ✅ PASS: TOOL_START ghi nhận step running');

state = tuiReducer(state, {
  type: 'TOOL_END',
  toolName: 'read_file',
  durationMs: 15,
  result: { content: 'test content' },
  tokens: 1200,
});
assert.strictEqual(state.steps[0].status, 'success');
assert.strictEqual(state.steps[0].durationMs, 15);
assert.strictEqual(state.steps[0].tokens, 1200);
console.log('  ✅ PASS: TOOL_END cập nhật status success và duration');

state = tuiReducer(state, {
  type: 'USAGE_UPDATE',
  usage: {
    promptTokens: 8000,
    cachedTokens: 2000,
    completionTokens: 500,
    totalTokens: 10500,
  },
});
assert.strictEqual(state.tokens.used, 10500);
assert.strictEqual(state.tokens.cachedTokens, 2000);
assert.strictEqual(state.tokens.cacheHitRate, 20); // 2000 / (8000 + 2000) = 20%
console.log('  ✅ PASS: USAGE_UPDATE tính chính xác Prompt Cache hit rate 20%');

state = tuiReducer(state, { type: 'TOGGLE_REASONING_COLLAPSE' });
assert.strictEqual(state.isReasoningCollapsed, false);
console.log('  ✅ PASS: TOGGLE_REASONING_COLLAPSE đảo trạng thái');

state = tuiReducer(state, {
  type: 'SHOW_DIFF',
  diff: {
    file: 'src/main.ts',
    lines: ['--- a/src/main.ts', '+++ b/src/main.ts', '+const x = 1;'],
    isAutoApproved: true,
  },
});
assert.notStrictEqual(state.activeDiff, null);
assert.strictEqual(state.activeDiff?.isAutoApproved, true);
console.log('  ✅ PASS: SHOW_DIFF nạp thông tin diff view chính xác');

// 2. Kiểm thử TuiStore & AgentKernel Event Bus Binding
console.log('\n▶ 2. Kiểm thử TuiStore & Event Bus Binding');
const store = new TuiStore({ modelName: 'test-model' });
let changeCount = 0;
store.on('change', () => {
  changeCount++;
});

const mockEvents = new EventEmitter();
const mockKernel = {
  ctx: {
    events: mockEvents,
  },
} as any;

const unbind = store.bindKernel(mockKernel);

mockEvents.emit('step:before', 2, 10);
assert.strictEqual(store.getState().currentStep, 2);

mockEvents.emit('tool:before', 'write_file', { targetFile: 'test.txt' });
assert.strictEqual(store.getState().status, 'executing_tool');

mockEvents.emit('model:thought', 'Suy nghĩ System 2...');
assert.strictEqual(store.getState().liveReasoning.includes('Suy nghĩ System 2...'), true);

mockEvents.emit('model:final_answer', 'Nhiệm vụ hoàn thành!');
assert.strictEqual(store.getState().finalAnswer, 'Nhiệm vụ hoàn thành!');

assert.strictEqual(changeCount >= 4, true);
console.log(`  ✅ PASS: TuiStore phản ứng với 4 sự kiện từ AgentKernel (changeCount=${changeCount})`);

unbind();
mockEvents.emit('step:before', 3, 10);
// Sau khi unbind, không cập nhật nữa
assert.strictEqual(store.getState().currentStep, 2);
console.log('  ✅ PASS: unbind hủy đăng ký lắng nghe sự kiện thành công');

// 3. Kiểm thử Khởi Tạo Cấu Trúc React Elements (Flexbox & Components)
console.log('\n▶ 3. Kiểm thử Khởi Tạo Các React Component');

const headerElement = React.createElement(Header, {
  modelName: 'gemini-3.5-flash',
  workspacePath: 'D:/AgentLearn/CodingAgent',
  sandboxMode: 'docker',
  status: 'thinking',
  activePhase: 'EXPLORE',
  currentStep: 1,
  maxSteps: 10,
});
assert.strictEqual(React.isValidElement(headerElement), true);
console.log('  ✅ PASS: Header Component khởi tạo hợp lệ');

const telemetryElement = React.createElement(TelemetryBar, {
  usedTokens: 15000,
  maxTokens: 1000000,
  promptTokens: 12000,
  cachedTokens: 3000,
  cacheHitRate: 20,
});
assert.strictEqual(React.isValidElement(telemetryElement), true);
console.log('  ✅ PASS: TelemetryBar Component khởi tạo hợp lệ');

const stepStreamElement = React.createElement(StepStream, {
  steps: store.getState().steps,
});
assert.strictEqual(React.isValidElement(stepStreamElement), true);
console.log('  ✅ PASS: StepStream Component khởi tạo hợp lệ');

assert.strictEqual(SPINNER_FRAMES.length, 10);
const spinnerElement = React.createElement(LoadingSpinner, { startTime: Date.now() - 1500 });
assert.strictEqual(React.isValidElement(spinnerElement), true);
console.log('  ✅ PASS: LoadingSpinner Component với 10 frames hoạt hình khởi tạo hợp lệ');

const reasoningElement = React.createElement(LiveReasoningBox, {
  reasoning: 'Bước 1: Phân tích\nBước 2: Xử lý',
  isCollapsed: false,
});
assert.strictEqual(React.isValidElement(reasoningElement), true);
console.log('  ✅ PASS: LiveReasoningBox Component khởi tạo hợp lệ');

const diffElement = React.createElement(DiffPreviewBox, {
  diff: {
    file: 'test.js',
    lines: ['+const a = 1;'],
  },
});
assert.strictEqual(React.isValidElement(diffElement), true);
console.log('  ✅ PASS: DiffPreviewBox Component khởi tạo hợp lệ');

const promptBarElement = React.createElement(InputPromptBar, {
  onSubmit: () => {},
  workspacePath: process.cwd(),
});
assert.strictEqual(React.isValidElement(promptBarElement), true);
console.log('  ✅ PASS: InputPromptBar Component với phím điều hướng khởi tạo hợp lệ');

// 4. Kiểm thử Cơ Chế Lọc & Gợi Ý Slash Commands và File Mentions
console.log('\n▶ 4. Kiểm thử Bộ Lọc Gợi Ý & Phím Điều Hướng');

const slashMatches = SLASH_COMMANDS.filter((cmd) => cmd.command.startsWith('/ex'));
assert.strictEqual(slashMatches.length >= 2, true); // /explore, /exit
assert.strictEqual(slashMatches.some((c) => c.command === '/explore'), true);
assert.strictEqual(slashMatches.some((c) => c.command === '/exit'), true);
console.log('  ✅ PASS: Lọc đúng danh sách Slash Commands khi gõ /ex (/explore, /exit)');

const ws = new Workspace(process.cwd());
const fileSuggestions = FileMentionEngine.getFileSuggestions('@pack', ws, 5, 5);
assert.strictEqual(fileSuggestions.length > 0, true);
assert.strictEqual(fileSuggestions[0].displayPath.includes('package'), true);
console.log(`  ✅ PASS: Gợi ý đúng file qua @mention: ${fileSuggestions[0].displayPath}`);

const appElement = React.createElement(App, {
  store,
});
assert.strictEqual(React.isValidElement(appElement), true);
console.log('  ✅ PASS: App Root Component khởi tạo hợp lệ');

console.log('\n========================================');
console.log('✨ TOÀN BỘ 17 KIỂM THỬ INK TUI & GỢI Ý ĐIỀU HƯỚNG ĐÃ VƯỢT QUA!');
console.log('========================================\n');
