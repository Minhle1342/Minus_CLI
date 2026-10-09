import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ContextCompactor } from './context-compactor.js';
import type { SessionMessage } from './context-compactor.js';

describe('Satellite 2: In-Turn Microcompaction', () => {
  const compactor = new ContextCompactor({
    enableObservationMasking: true,
    maskOldObservationsBeyondN: 2,
    preserveLastNToolResults: 2,
  });

  it('Scenario 1: Turn có 4 step -> Step 1 & 2 tool results bị microcompact, Step 3 & 4 giữ nguyên vẹn', async () => {
    // Construct an active turn with 1 user prompt + 4 tool exchanges (total 9 messages)
    const messages: SessionMessage[] = [
      { role: 'user', parts: [{ text: 'Please investigate and test the repo' }] },
      // Step 1: read_file (old)
      { role: 'model', parts: [{ functionCall: { id: 'call_read_1', name: 'read_file', args: { path: 'src/module.ts' } } as any }] },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            name: 'read_file',
            id: 'call_read_1',
            response: { path: 'src/module.ts', content: 'export const x = 1;\n'.repeat(100) },
          },
        }],
      },
      // Step 2: run_command (old)
      { role: 'model', parts: [{ functionCall: { id: 'call_cmd_2', name: 'run_command', args: { command: 'npm test' } } as any }] },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            name: 'run_command',
            id: 'call_cmd_2',
            response: { command: 'npm test', exitCode: 0, stdout: 'PASS test/auth.test.ts\n'.repeat(50) },
          },
        }],
      },
      // Step 3: edit_file (recent N-1)
      { role: 'model', parts: [{ functionCall: { id: 'call_edit_3', name: 'replace_text', args: { path: 'src/module.ts' } } as any }] },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            name: 'replace_text',
            id: 'call_edit_3',
            response: { path: 'src/module.ts', success: true, diff: '+ export const x = 2;' },
          },
        }],
      },
      // Step 4: run_command verify (recent N)
      { role: 'model', parts: [{ functionCall: { id: 'call_cmd_4', name: 'run_command', args: { command: 'npm test' } } as any }] },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            name: 'run_command',
            id: 'call_cmd_4',
            response: { command: 'npm test', exitCode: 0, stdout: 'All 15 tests passed' },
          },
        }],
      },
    ];

    const result = await compactor.compact(messages, {
      protectActiveTurn: true,
      enableObservationMasking: true,
    });

    const compacted = result.messages;
    assert.strictEqual(compacted.length, messages.length);

    // Step 1 (read_file) should be masked/compacted
    const step1Response = compacted[2].parts?.[0]?.functionResponse?.response as Record<string, any>;
    assert.strictEqual(step1Response.status, 'masked');
    assert.ok(step1Response.observationMask?.includes('OBSERVATION MASKED'));

    // Step 2 (run_command) should be masked/compacted
    const step2Response = compacted[4].parts?.[0]?.functionResponse?.response as Record<string, any>;
    assert.strictEqual(step2Response.status, 'masked');
    assert.strictEqual(step2Response.exitCode, 0);

    // Step 3 (replace_text - step N-1) should remain intact
    const step3Response = compacted[6].parts?.[0]?.functionResponse?.response as Record<string, any>;
    assert.strictEqual(step3Response.success, true);
    assert.strictEqual(step3Response.diff, '+ export const x = 2;');

    // Step 4 (run_command - step N) should remain intact
    const step4Response = compacted[8].parts?.[0]?.functionResponse?.response as Record<string, any>;
    assert.strictEqual(step4Response.stdout, 'All 15 tests passed');
  });

  it('Scenario 2: Turn ngắn (1-2 tool steps, <= 4 messages) -> giữ nguyên 100%', async () => {
    const messages: SessionMessage[] = [
      { role: 'user', parts: [{ text: 'Quick check' }] },
      { role: 'model', parts: [{ functionCall: { id: 'call_quick', name: 'read_file', args: { path: 'package.json' } } as any }] },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            name: 'read_file',
            id: 'call_quick',
            response: { path: 'package.json', content: '{"name": "test"}' },
          },
        }],
      },
    ];

    const result = await compactor.compact(messages, {
      protectActiveTurn: true,
      enableObservationMasking: true,
    });

    const resp = result.messages[2].parts?.[0]?.functionResponse?.response as Record<string, any>;
    assert.strictEqual(resp.content, '{"name": "test"}');
    assert.strictEqual(resp.status, undefined);
  });
});
