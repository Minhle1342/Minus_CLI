import assert from 'node:assert/strict';
import test from 'node:test';
import { assertHistoryToolPairing, collectToolPairSpans, demoteOrphanToolResponses } from './session-invariants.js';

const call = (id: string) => ({ role: 'model', parts: [{ functionCall: { name: 'read_file', args: {}, id } }] }) as any;
const resp = (id: string, response: unknown = { content: 'x' }) => ({ role: 'user', parts: [{ functionResponse: { name: 'read_file', id, response } }] }) as any;

test('demoteOrphanToolResponses demotes only responses with no call anywhere', () => {
  const messages = [
    { role: 'user', parts: [{ text: 'hi' }] },
    call('call-keep'),
    resp('call-keep'),
    resp('call-orphan', { content: 'lost parent' }),
  ] as any;
  const { messages: fixed, demotedIds } = demoteOrphanToolResponses(messages);
  assert.deepEqual(demotedIds, ['call-orphan']);
  // Valid pair untouched.
  assert.deepEqual(fixed[1], messages[1]);
  assert.deepEqual(fixed[2], messages[2]);
  // Orphan demoted to marked text preserving payload.
  const demoted = (fixed[3] as any).parts[0];
  assert.equal(demoted.functionResponse, undefined);
  assert.match(demoted.text, /RECOVERED UNPAIRED OBSERVATION read_file:call-orphan/);
  assert.match(demoted.text, /lost parent/);
  // Fixed history passes the pairing invariant.
  assertHistoryToolPairing(fixed as any);
});

test('demoteOrphanToolResponses caps huge payloads and leaves misordered pairs alone', () => {
  const big = { content: 'y'.repeat(5000) };
  const misordered = [{ role: 'user', parts: [{ text: 'q' }] }, resp('call-late'), call('call-late')] as any;
  const { messages: fixed, demotedIds } = demoteOrphanToolResponses([
    resp('call-big', big),
    ...misordered,
  ] as any);
  assert.deepEqual(demotedIds, ['call-big']);
  const text = (fixed[0] as any).parts[0].text as string;
  assert.ok(text.length < 5000 && text.includes('chars omitted'));
  // Misordered pair (call exists later) is NOT demoted — still loud downstream.
  assert.deepEqual(fixed[3], misordered[2]);
  assert.throws(() => assertHistoryToolPairing(fixed as any), /orphan tool result id call-late/);
});

test('demoteOrphanToolResponses is a no-op on healthy histories', () => {
  const messages = [{ role: 'user', parts: [{ text: 'q' }] }, call('a'), resp('a')] as any;
  const { messages: fixed, demotedIds } = demoteOrphanToolResponses(messages);
  assert.deepEqual(demotedIds, []);
  assert.deepEqual(fixed, messages);
});

test('collectToolPairSpans locates pairs including cross-turn spans', () => {
  const messages = [
    { role: 'user', parts: [{ text: 'turn one' }] },
    call('early'),
    { role: 'user', parts: [{ text: 'turn two' }] },
    { role: 'user', parts: [{ text: 'turn three' }] },
    resp('early'), // background result landing two turns later
    resp('ghost'), // no call anywhere
  ] as any;
  assert.deepEqual(collectToolPairSpans(messages), [
    { id: 'early', callIdx: 1, respIdx: 4 },
    { id: 'ghost', callIdx: -1, respIdx: 5 },
  ]);
});
