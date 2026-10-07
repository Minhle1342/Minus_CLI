import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import React from 'react';
import { LiveReasoningBox } from './components/LiveReasoningBox.js';
import { TuiStore, createInitialState, tuiReducer } from './tui-store.js';

function visibleText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(visibleText).join(' ');
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return visibleText(node.props.children);
  return '';
}

describe('Ink reasoning cancellation UX', () => {
  it('flushes the last batched tokens, freezes the trace, and unlocks only when the agent settles', () => {
    const events = new EventEmitter();
    let aborts = 0;
    const store = new TuiStore();
    events.on('agent:abort', () => { aborts++; });
    const unbind = store.bindKernel({
      ctx: { events },
      cancelCurrentTask: () => { events.emit('agent:abort'); events.emit('abort'); },
      abort: () => { throw new Error('duplicate abort'); },
    } as any);
    try {
      events.emit('step:before', 1, 3);
      events.emit('model:thinking:start', { startedAt: Date.now() });
      events.emit('model:thought', 'Already received, still buffered.');
      store.abortCurrent();

      assert.equal(store.getState().liveReasoning, 'Already received, still buffered.');
      assert.equal(store.getState().reasoningInterrupted, true);
      assert.equal(store.getState().isAborting, true);
      assert.equal(aborts, 1);
      store.abortCurrent();
      assert.equal(aborts, 1, 'repeat Esc/Ctrl+C must not send another abort');

      events.emit('model:thought', 'late token');
      events.emit('model:thinking:end');
      assert.equal(store.getState().liveReasoning, 'Already received, still buffered.');
      assert.equal(store.getState().status, 'thinking', 'provider completion alone must not unlock input');
      assert.equal(store.getState().isThinking, false);
      events.emit('agent/status', { id: 'subagent-1', status: 'idle' });
      assert.equal(store.getState().isAborting, true, 'a subagent must not settle the interactive turn');

      events.emit('agent/status', { id: 'coding-agent', status: 'idle' });
      assert.equal(store.getState().status, 'idle');
      assert.equal(store.getState().isAborting, false);
      assert.equal(store.getState().reasoningInterrupted, true);
      events.emit('model:thought', 'even later token');
      assert.equal(store.getState().liveReasoning, 'Already received, still buffered.');

      events.emit('step:before', 2, 3);
      assert.equal(store.getState().reasoningInterrupted, false);
      assert.equal(store.getState().liveReasoning, '');
    } finally {
      unbind();
    }
  });

  it('shows an interruption marker with or without reasoning, without a frozen spinner', () => {
    for (const reasoning of ['', 'Partial thought']) {
      for (const isCollapsed of [true, false]) {
        const base = { reasoning, isCollapsed, status: 'idle' as const, isThinking: false, reasoningInterrupted: true };
        assert.match(visibleText(LiveReasoningBox(base)), /Thinking interrupted/);
        assert.match(visibleText(LiveReasoningBox({ ...base, isAborting: true })), /Stopping/);
      }
    }
  });

  it('preserves normal thinking and final-answer behavior, and does not label tool abort as reasoning', () => {
    let state = tuiReducer(createInitialState({}), { type: 'THINKING_START', startedAt: 1 });
    state = tuiReducer(state, { type: 'REASONING_CHUNK', chunk: 'normal thought' });
    state = tuiReducer(state, { type: 'THINKING_END' });
    assert.equal(state.reasoningInterrupted, false);
    assert.equal(state.liveReasoning, 'normal thought');
    state = tuiReducer(state, { type: 'FINAL_ANSWER', answer: 'Done' });
    assert.equal(state.status, 'completed');
    assert.equal(state.reasoningInterrupted, false);

    state = tuiReducer(state, { type: 'TOOL_START', toolName: 'read_file', args: {}, step: 2, maxSteps: 3, phase: 'EXPLORE' });
    state = tuiReducer(state, { type: 'SET_ABORTING', isAborting: true });
    assert.equal(state.reasoningInterrupted, false);
    state = tuiReducer(state, { type: 'ABORT_SETTLED' });
    assert.equal(state.status, 'idle');
    assert.equal(state.reasoningInterrupted, false);

    let pending = tuiReducer(createInitialState({}), { type: 'THINKING_START', startedAt: 1 });
    pending = tuiReducer(pending, { type: 'SET_ABORTING', isAborting: true });
    pending = tuiReducer(pending, { type: 'FINAL_ANSWER', answer: 'The request finished before cancellation' });
    assert.equal(pending.isAborting, false);
    assert.equal(pending.reasoningInterrupted, false, 'a completed answer is not an interrupted thought');

    pending = tuiReducer(createInitialState({}), { type: 'THINKING_START', startedAt: 1 });
    pending = tuiReducer(pending, { type: 'SET_ABORTING', isAborting: true });
    pending = tuiReducer(pending, { type: 'ABORT_SETTLED', failed: true });
    assert.equal(pending.status, 'error');
    assert.equal(pending.reasoningInterrupted, false, 'a failed turn must not claim successful cancellation');
  });

  it('distinctly separates thinking state and reconnecting retry state on TUI', () => {
    const events = new EventEmitter();
    const store = new TuiStore();
    const unbind = store.bindKernel({ ctx: { events } } as any);

    try {
      events.emit('step:before', 1, 3);
      events.emit('model:thinking:start', { startedAt: Date.now() });

      // 1. Thinking state: chưa có token, đang hiển thị spinner Thinking
      assert.equal(store.getState().status, 'thinking');
      assert.equal(store.getState().isThinking, true);
      assert.equal(store.getState().retryInfo, null);
      let rendered = visibleText(LiveReasoningBox({
        reasoning: '',
        isCollapsed: false,
        status: store.getState().status,
        isThinking: store.getState().isThinking,
        retryInfo: store.getState().retryInfo,
      }));
      assert.match(rendered, /Thinking:/);
      assert.doesNotMatch(rendered, /Đang thử kết nối lại/);

      // 2. Retrying state: LLM gặp lỗi mạng/rate limit và bắt đầu retry kết nối lại
      events.emit('model:retry', {
        attempt: 1,
        maxRetries: 3,
        delayMs: 2000,
        message: 'Rate limit exceeded',
      });

      assert.equal(store.getState().status, 'retrying');
      assert.ok(store.getState().retryInfo);
      assert.equal(store.getState().retryInfo?.attempt, 1);
      rendered = visibleText(LiveReasoningBox({
        reasoning: '',
        isCollapsed: false,
        status: store.getState().status,
        isThinking: store.getState().isThinking,
        retryInfo: store.getState().retryInfo,
      }));
      // Phải hiển thị rõ đang thử kết nối lại và KHÔNG hiển thị Thinking
      assert.match(rendered, /Đang thử kết nối lại với LLM/);
      assert.match(rendered, /lần 1\/3 sau 2\.0s/);
      assert.doesNotMatch(rendered, /Thinking:/);

      // 3. Reconnect thành công: nhận được token suy nghĩ đầu tiên
      events.emit('model:thought', 'Model is now thinking after successful reconnect.');
      assert.equal(store.getState().status, 'thinking');
      assert.equal(store.getState().retryInfo, null);
      events.emit('model:thinking:end');
      rendered = visibleText(LiveReasoningBox({
        reasoning: store.getState().liveReasoning,
        isCollapsed: false,
        status: store.getState().status,
        isThinking: store.getState().isThinking,
        retryInfo: store.getState().retryInfo,
      }));
      assert.match(rendered, /REASONING TRACE/);
      assert.match(rendered, /Model is now thinking/);
      assert.doesNotMatch(rendered, /Đang thử kết nối lại/);
    } finally {
      unbind();
    }
  });
});
