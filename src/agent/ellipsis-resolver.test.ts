import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveEllipticalFollowUp } from './ellipsis-resolver.js';

const PAGE_A = 'Cho tôi biết các thành phần có trong giao diện A';

test('Vietnamese follow-up inherits the previous turn topic', () => {
  const result = resolveEllipticalFollowUp({
    current: 'còn trang B thì sao',
    previousUserPrompts: [PAGE_A],
  });
  assert.equal(result.applied, true);
  assert.ok(result.expandedQuery.includes('còn trang B thì sao'));
  assert.ok(result.expandedQuery.includes('các thành phần'));
  assert.ok(result.expandedQuery.includes('giao diện A'));
});

test('short follow-up without outer pipes still resolves', () => {
  const result = resolveEllipticalFollowUp({
    current: 'trang B thì sao?',
    previousUserPrompts: [PAGE_A],
  });
  assert.equal(result.applied, true);
  assert.ok(result.inheritedTopic?.includes('giao diện A'));
});

test('English follow-up inherits the previous turn topic', () => {
  const result = resolveEllipticalFollowUp({
    current: 'what about page B?',
    previousUserPrompts: ['List the components available on page A'],
  });
  assert.equal(result.applied, true);
  assert.ok(result.expandedQuery.includes('what about page B?'));
  assert.ok(result.expandedQuery.includes('components'));
});

test('self-contained questions are left untouched', () => {
  const current =
    'Hãy liệt kê chi tiết các thành phần giao diện còn thiếu trên trang B so với trang A kèm theo vị trí hiển thị của chúng';
  const result = resolveEllipticalFollowUp({
    current,
    previousUserPrompts: [PAGE_A],
  });
  assert.equal(result.applied, false);
  assert.equal(result.expandedQuery, current);
});

test('system markers and slash commands are never rewritten', () => {
  for (const current of ['[RESUME INCOMPLETE PLAN]', '/plan tiếp tục task 3', '']) {
    const result = resolveEllipticalFollowUp({
      current,
      previousUserPrompts: [PAGE_A],
    });
    assert.equal(result.applied, false, current || '(empty)');
  }
});

test('no antecedent means no resolution', () => {
  const result = resolveEllipticalFollowUp({
    current: 'còn trang B thì sao',
    previousUserPrompts: [],
  });
  assert.equal(result.applied, false);
  assert.equal(result.expandedQuery, 'còn trang B thì sao');
});

test('elliptical predecessors are skipped in favor of contentful ones', () => {
  const result = resolveEllipticalFollowUp({
    current: 'còn trang C thì sao',
    previousUserPrompts: [PAGE_A, 'còn trang B thì sao'],
  });
  assert.equal(result.applied, true);
  assert.ok(result.inheritedTopic?.includes('giao diện A'));
});

test('archived turns backfill the topic after deep compaction', () => {
  const result = resolveEllipticalFollowUp({
    current: 'còn trang B thì sao',
    previousUserPrompts: [],
    archivedTurns: [
      {
        userPrompt: PAGE_A,
        assistantSummary: 'Đã liệt kê các thành phần của giao diện A',
        keyDecisions: [],
      },
    ],
  });
  assert.equal(result.applied, true);
  assert.ok(result.expandedQuery.includes('các thành phần'));
});
