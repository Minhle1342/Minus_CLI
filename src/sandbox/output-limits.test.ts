import test from 'node:test';
import assert from 'node:assert/strict';
import { checkArrayLength, checkStringLength, nextDepth } from './output-limits.js';

test('output limits fail fast with RangeError', () => {
  assert.throws(() => checkStringLength(2 ** 24 + 1), RangeError);
  assert.throws(() => checkArrayLength(10_000_001), RangeError);
  assert.throws(() => nextDepth(10_000), RangeError);
  assert.equal(nextDepth(0), 1);
});
