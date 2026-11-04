import assert from 'node:assert/strict';
import test from 'node:test';
import { Session } from '../session/session.js';
import { EffectLedger } from './effect-ledger.js';

test('effect ledger tracks transitions and sees external appends', () => {
  const session = new Session();
  const ledger = new EffectLedger();
  ledger.bindSession(session);

  const prepared = ledger.prepare('replace_text', 'call-1');
  assert.equal(ledger.get(prepared.id)?.status, 'prepared');

  const committed = ledger.commit(prepared.id);
  assert.equal(committed?.status, 'committed');
  assert.equal(ledger.get(prepared.id)?.status, 'committed');

  // A write that bypasses the ledger must invalidate the cached index.
  session.append('effect/change', {
    effect: {
      id: 'external',
      toolName: 'write_file',
      toolCallId: 'call-2',
      status: 'prepared',
      reversible: true,
      preparedAt: new Date().toISOString(),
    },
    reason: 'prepared',
  });

  assert.equal(ledger.get('external')?.toolName, 'write_file');
  assert.equal(ledger.list().length, 2);
});
