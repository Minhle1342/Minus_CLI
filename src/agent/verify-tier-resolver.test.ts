import test from 'node:test';
import assert from 'node:assert/strict';
import { isSensitivePath, resolveVerifyTier } from './verify-tier-resolver.js';

test('small caller-free edits stay LOW and inherit the ladder', () => {
  assert.deepEqual(resolveVerifyTier({ changedFileCount: 2, hasCallers: false }), {
    level: 'LOW',
    minTier: 'inherit',
    reasons: [],
  });
});

test('file-count boundary escalates at the threshold', () => {
  assert.equal(resolveVerifyTier({ changedFileCount: 2, hasCallers: false }).level, 'LOW');
  const at = resolveVerifyTier({ changedFileCount: 3, hasCallers: false });
  assert.equal(at.level, 'HIGH');
  assert.equal(at.minTier, 'full_test');
  assert.ok(at.reasons.join(' ').includes('3 files'));
});

test('known callers escalate a single-file edit', () => {
  const decision = resolveVerifyTier({ changedFileCount: 1, hasCallers: true });
  assert.equal(decision.level, 'HIGH');
  assert.equal(decision.minTier, 'full_test');
});

test('R3 and measured HIGH blast escalate', () => {
  assert.equal(resolveVerifyTier({ changedFileCount: 1, hasCallers: false, classificationRisk: 'R3' }).level, 'HIGH');
  assert.equal(resolveVerifyTier({ changedFileCount: 1, hasCallers: false, blastRisk: 'HIGH' }).level, 'HIGH');
});

test('R4, many files, and sensitive paths are CRITICAL', () => {
  assert.equal(resolveVerifyTier({ changedFileCount: 1, hasCallers: false, classificationRisk: 'R4' }).level, 'CRITICAL');
  assert.equal(resolveVerifyTier({ changedFileCount: 12, hasCallers: false }).level, 'CRITICAL');
  assert.equal(resolveVerifyTier({ changedFileCount: 1, hasCallers: false, sensitivePathTouched: true }).level, 'CRITICAL');
});

test('isSensitivePath matches auth/payment/migration-adjacent paths', () => {
  assert.equal(isSensitivePath('src/auth/session.ts'), true);
  assert.equal(isSensitivePath('src/billing/checkout.py'), true);
  assert.equal(isSensitivePath('db/migrate/001.sql'), true);
  assert.equal(isSensitivePath('src/utils/format.ts'), false);
});
