import test from 'node:test';
import assert from 'node:assert/strict';
import { WEB_SEARCH_DECISION_POLICY } from './search-plugin.js';

test('policy orders LLM to dig deeper than snippets', () => {
  assert.ok(WEB_SEARCH_DECISION_POLICY.includes('DIG DEEPER'), 'missing DIG DEEPER section');
  assert.ok(
    WEB_SEARCH_DECISION_POLICY.includes('Never answer from titles/snippets alone'),
    'must forbid answering from snippets alone',
  );
  assert.ok(
    WEB_SEARCH_DECISION_POLICY.includes('at least two independent sources'),
    'must require cross-checking contested claims',
  );
});
