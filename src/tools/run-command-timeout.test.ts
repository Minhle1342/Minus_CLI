import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRunCommandTimeout } from './run-command.js';

describe('resolveRunCommandTimeout', () => {
  it('timeout_ms=0 disables the timeout', () => {
    assert.equal(resolveRunCommandTimeout(0, 120000), 0);
    assert.equal(resolveRunCommandTimeout('0', 120000), 0);
  });

  it('clamps finite values to [1000, 300000]', () => {
    assert.equal(resolveRunCommandTimeout(500, 120000), 1000);
    assert.equal(resolveRunCommandTimeout(60000, 120000), 60000);
    assert.equal(resolveRunCommandTimeout(999999, 120000), 300000);
  });

  it('falls back to configured default, then 120000', () => {
    assert.equal(resolveRunCommandTimeout(undefined, 60000), 60000);
    assert.equal(resolveRunCommandTimeout(undefined, 0), 120000);
    assert.equal(resolveRunCommandTimeout(NaN, undefined), 120000);
  });
});
