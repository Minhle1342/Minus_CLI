import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContextCompactor, countDegradedObservations, isDegradedObservationPayload } from './context-compactor.js';
import { ContextBudgetManager } from './context-budget-manager.js';

function degradedHistory(count: number): any[] {
  const history: any[] = [{ role: 'user', parts: [{ text: 'Inspect the repo and report findings.' }] }];
  for (let i = 0; i < count; i++) {
    history.push({ role: 'model', parts: [{ functionCall: { id: `read-${i}`, name: 'read_file', args: { path: `src/${i}.ts` } } }] });
    history.push({
      role: 'user',
      parts: [{
        functionResponse: {
          id: `read-${i}`,
          name: 'read_file',
          response: { path: `src/${i}.ts`, status: 'masked', observationMask: '[OBSERVATION MASKED: archived]', archiveId: `arch-${i}` },
        },
      }],
    });
  }
  return history;
}

/** Lịch sử thực tế: các observation cũ đã bị nén + vài observation còn nguyên ở đuôi. */
function mixedHistory(degraded: number, live: number): any[] {
  const history = degradedHistory(degraded);
  for (let i = 0; i < live; i++) {
    const id = `live-${i}`;
    history.push({ role: 'model', parts: [{ functionCall: { id, name: 'read_file', args: { path: `src/live-${i}.ts` } } }] });
    history.push({
      role: 'user',
      parts: [{ functionResponse: { id, name: 'read_file', response: { path: `src/live-${i}.ts`, content: 'evidence '.repeat(900) } } }],
    });
  }
  return history;
}

/** Counter đo theo kích thước history thật để phản ánh savings sau khi nén. */
function sizeCounter() {
  return {
    async count(envelope: any) {
      const tokens = Math.ceil(JSON.stringify(envelope.history).length / 4);
      return {
        inputTokens: tokens,
        upperBoundTokens: tokens,
        historyTokens: tokens,
        nonHistoryTokens: 0,
        source: 'tokenizer' as const,
        hardBound: false,
        errorMarginRatio: 0,
      };
    },
  };
}

function liveHistory(count: number): any[] {
  const history: any[] = [{ role: 'user', parts: [{ text: 'Inspect the repo and report findings.' }] }];
  for (let i = 0; i < count; i++) {
    history.push({ role: 'model', parts: [{ functionCall: { id: `read-${i}`, name: 'read_file', args: { path: `src/${i}.ts` } } }] });
    history.push({
      role: 'user',
      parts: [{ functionResponse: { id: `read-${i}`, name: 'read_file', response: { path: `src/${i}.ts`, content: 'evidence' } } }],
    });
  }
  return history;
}

function counterWith(upperBoundTokens: number) {
  return {
    async count() {
      return {
        inputTokens: upperBoundTokens,
        upperBoundTokens,
        historyTokens: upperBoundTokens,
        nonHistoryTokens: 0,
        source: 'tokenizer' as const,
        hardBound: false,
        errorMarginRatio: 0,
      };
    },
  };
}

test('isDegradedObservationPayload nhận diện đúng các hình dạng stub của compactor', () => {
  assert.equal(isDegradedObservationPayload({ status: 'masked' }), true);
  assert.equal(isDegradedObservationPayload({ status: 'superseded' }), true);
  assert.equal(isDegradedObservationPayload({ status: 'compacted' }), true);
  assert.equal(isDegradedObservationPayload({ observationMask: '[OBSERVATION MASKED: ...]' }), true);
  assert.equal(isDegradedObservationPayload({ semanticOutline: 'outline' }), true);
  assert.equal(isDegradedObservationPayload({ summary: '[HARD-BUDGET OBSERVATION STUB: 900 chars archived]' }), true);
  assert.equal(isDegradedObservationPayload({ summary: '[Compressed data: ...]' }), true);
  // Payload thật chưa bị nén thì KHÔNG tính là mất context.
  assert.equal(isDegradedObservationPayload({ path: 'a.ts', content: 'full content' }), false);
  assert.equal(isDegradedObservationPayload({ stdout: 'log', exitCode: 0 }), false);
  assert.equal(isDegradedObservationPayload(undefined), false);
});

test('countDegradedObservations chỉ đếm tool observation đã bị nén', () => {
  const messages: any[] = [
    { role: 'user', parts: [{ text: 'go' }] },
    { role: 'user', parts: [{ functionResponse: { id: 'a', name: 'read_file', response: { status: 'masked' } } }] },
    { role: 'user', parts: [{ functionResponse: { id: 'b', name: 'read_file', response: { content: 'kept' } } }] },
    { role: 'user', parts: [{ functionResponse: { id: 'c', name: 'run_command', response: { observationMask: 'x' } } }] },
  ];
  assert.equal(countDegradedObservations(messages), 2);
  assert.equal(countDegradedObservations(liveHistory(5)), 0);
  assert.equal(countDegradedObservations(degradedHistory(9)), 9);
});

test('lịch sử đã mất tool context → nén sớm hơn triggerRatio thường', async () => {
  const compactor = new ContextCompactor({ preserveLastNToolResults: 2 });
  const manager = new ContextBudgetManager(compactor, {
    mode: 'enforce',
    triggerRatio: 0.75,
    counter: sizeCounter(),
  });
  const envelope = {
    provider: 'test', model: 'test', systemPrompt: 'system', tools: [],
    history: mixedHistory(8, 6),
    maxInputTokens: 20_000, outputReserveTokens: 100,
  };
  const before = await manager.counter.count(envelope);
  // Nằm giữa degradedContextRatio (50%) và triggerRatio (75%) → chưa có áp lực token.
  assert.ok(before.upperBoundTokens > 9_950 && before.upperBoundTokens < 14_925,
    `token phải nằm giữa 50% và 75% ngân sách, got ${before.upperBoundTokens}`);

  const degraded = await manager.prepareRequest(envelope);
  assert.equal(degraded.changed, true, 'phải nén sớm khi context đã mất tool context');
  assert.ok(degraded.after.historyTokens < degraded.before.historyTokens, 'nén phải tiết kiệm token thật');

  // Cùng kích thước, nhưng lịch sử KHÔNG mất tool context → không nén.
  // Dùng manager mới để hysteresis/growth của lần nén trước không chi phối.
  const cleanManager = new ContextBudgetManager(new ContextCompactor({ preserveLastNToolResults: 2 }), {
    mode: 'enforce',
    triggerRatio: 0.75,
    counter: sizeCounter(),
  });
  const clean = await cleanManager.prepareRequest({ ...envelope, history: mixedHistory(0, 6) });
  assert.equal(clean.changed, false, 'không nén khi tool context còn nguyên');
});

test('điều kiện không lặp mỗi request: sau khi nén, token tụt dưới ngưỡng thì tắt', async () => {
  const manager = new ContextBudgetManager(new ContextCompactor({ preserveLastNToolResults: 2 }), {
    mode: 'enforce',
    triggerRatio: 0.75,
    counter: sizeCounter(),
  });
  const envelope = {
    provider: 'test', model: 'test', systemPrompt: 'system', tools: [],
    history: mixedHistory(8, 6),
    maxInputTokens: 20_000, outputReserveTokens: 100,
  };
  const first = await manager.prepareRequest(envelope);
  assert.equal(first.changed, true);
  // Sau khi nén, lịch sử nhỏ lại → không kích hoạt nén lần nữa.
  const compacted = { ...envelope, history: first.history };
  const second = await manager.prepareRequest(compacted);
  assert.equal(second.changed, false, 'không được nén lặp lại ở mỗi request');
});

test('tắt được bằng degradedObservationThreshold = 0', async () => {
  const manager = new ContextBudgetManager(new ContextCompactor(), {
    mode: 'enforce',
    triggerRatio: 0.75,
    degradedObservationThreshold: 0,
    counter: counterWith(12_000),
  });
  const result = await manager.prepareRequest({
    provider: 'test', model: 'test', systemPrompt: 'system', tools: [],
    history: mixedHistory(8, 6),
    maxInputTokens: 20_000, outputReserveTokens: 100,
  });
  assert.equal(result.changed, false);
});
