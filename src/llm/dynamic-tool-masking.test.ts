import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiLLM } from './gemini.js';
import { Session } from '../session/session.js';
import { partitionToolCalls, type ScheduledToolCall } from '../agent/tool-execution-scheduler.js';

describe('Dynamic Tool Masking & Parallel Inspection', () => {
  it('configures toolConfig.functionCallingConfig with AUTO mode and omits allowedFunctionNames in AUTO', async () => {
    const llm = new GeminiLLM('dummy-key');
    let capturedConfig: any;
    (llm as any).client = {
      models: {
        generateContentStream: async ({ config }: any) => {
          capturedConfig = config;
          return {
            async *[Symbol.asyncIterator]() {
              yield { text: () => 'done', functionCalls: [] };
            },
          };
        },
      },
    };

    const session = new Session('masking-test');
    const tools: any[] = [
      { name: 'read_file', description: 'Read file' },
      { name: 'replace_text', description: 'Edit file' },
      { name: 'submit_solution', description: 'Submit' },
    ];

    await llm.generateStream(session, tools, undefined, {
      allowedFunctionNames: ['read_file'],
    });

    assert.ok(capturedConfig.toolConfig, 'toolConfig must be defined');
    assert.equal(capturedConfig.toolConfig.functionCallingConfig.mode, 'AUTO');
    assert.equal(
      capturedConfig.toolConfig.functionCallingConfig.allowedFunctionNames,
      undefined,
      'allowedFunctionNames must NOT be set in AUTO mode per Gemini API rules',
    );
  });

  it('configures toolConfig with ANY and allowedFunctionNames when functionCallingMode is ANY', async () => {
    const llm = new GeminiLLM('dummy-key');
    let capturedConfig: any;
    (llm as any).client = {
      models: {
        generateContentStream: async ({ config }: any) => {
          capturedConfig = config;
          return {
            async *[Symbol.asyncIterator]() {
              yield { text: () => 'done', functionCalls: [] };
            },
          };
        },
      },
    };

    const session = new Session('masking-any-test');
    const tools: any[] = [
      { name: 'read_file', description: 'Read file' },
      { name: 'replace_text', description: 'Edit file' },
      { name: 'submit_solution', description: 'Submit' },
    ];

    await llm.generateStream(session, tools, undefined, {
      functionCallingMode: 'ANY',
      allowedFunctionNames: ['read_file'],
    });

    assert.ok(capturedConfig.toolConfig, 'toolConfig must be defined');
    assert.equal(capturedConfig.toolConfig.functionCallingConfig.mode, 'ANY');
    assert.deepEqual(capturedConfig.toolConfig.functionCallingConfig.allowedFunctionNames, ['read_file']);
  });

  it('sets mode to NONE when allowedFunctionNames is empty (post-submission)', async () => {
    const llm = new GeminiLLM('dummy-key');
    let capturedConfig: any;
    (llm as any).client = {
      models: {
        generateContentStream: async ({ config }: any) => {
          capturedConfig = config;
          return {
            async *[Symbol.asyncIterator]() {
              yield { text: () => 'all done', functionCalls: [] };
            },
          };
        },
      },
    };

    const session = new Session('masking-empty-test');
    const tools: any[] = [
      { name: 'read_file', description: 'Read file' },
    ];

    await llm.generateStream(session, tools, undefined, {
      allowedFunctionNames: [],
    });

    assert.ok(capturedConfig.toolConfig, 'toolConfig must be defined');
    assert.equal(capturedConfig.toolConfig.functionCallingConfig.mode, 'NONE');
  });

  it('partitions multiple read-only inspection tools concurrently in parallel', () => {
    const calls: ScheduledToolCall[] = [
      { index: 0, id: 'c1', name: 'read_file', args: { path: 'a.ts' } },
      { index: 1, id: 'c2', name: 'query_call_graph', args: { symbol: 'foo' } },
      { index: 2, id: 'c3', name: 'inspect_symbol', args: { symbol: 'bar' } },
      { index: 3, id: 'c4', name: 'replace_text', args: { path: 'a.ts' } },
    ];

    const partitions = partitionToolCalls(calls, true);
    assert.equal(partitions.length, 2);
    assert.equal(partitions[0].mode, 'concurrent-read');
    assert.deepEqual(partitions[0].calls.map((c) => c.name), [
      'read_file',
      'query_call_graph',
      'inspect_symbol',
    ]);
    assert.equal(partitions[1].mode, 'sequential');
    assert.equal(partitions[1].calls[0].name, 'replace_text');
  });

  it('chunks large read batches exceeding maxConcurrency limit', () => {
    const calls: ScheduledToolCall[] = Array.from({ length: 8 }, (_, i) => ({
      index: i,
      id: `c-${i}`,
      name: 'read_file',
      args: { path: `${i}.ts` },
    }));

    const partitions = partitionToolCalls(calls, true, 6);
    assert.equal(partitions.length, 2, '8 calls should be chunked into 2 batches');
    assert.equal(partitions[0].mode, 'concurrent-read');
    assert.equal(partitions[0].calls.length, 6);
    assert.equal(partitions[1].mode, 'concurrent-read');
    assert.equal(partitions[1].calls.length, 2);
  });

  it('keeps mutations as strict sequential barriers between read batches', () => {
    const calls: ScheduledToolCall[] = [
      { index: 0, id: 'c0', name: 'read_file', args: { path: 'a.ts' } },
      { index: 1, id: 'c1', name: 'search_text', args: { query: 'foo' } },
      { index: 2, id: 'c2', name: 'replace_text', args: { path: 'a.ts' } },
      { index: 3, id: 'c3', name: 'read_file', args: { path: 'b.ts' } },
      { index: 4, id: 'c4', name: 'get_diagnostics', args: {} },
    ];

    const partitions = partitionToolCalls(calls, true);
    assert.equal(partitions.length, 3);
    assert.equal(partitions[0].mode, 'concurrent-read');
    assert.equal(partitions[0].calls.length, 2);
    assert.equal(partitions[1].mode, 'sequential');
    assert.equal(partitions[1].calls[0].name, 'replace_text');
    assert.equal(partitions[2].mode, 'concurrent-read');
    assert.equal(partitions[2].calls.length, 2);
  });
});
