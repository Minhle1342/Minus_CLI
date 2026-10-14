import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLLMError } from './error-handling.js';
import { DeepseekLLM } from './deepseek.js';
import { AgentLoop } from '../agent/agent-loop.js';
import { Session } from '../session/session.js';
import { Workspace } from '../workspace/workspace.js';
import { ToolRegistry } from '../tools/registry.js';

describe('Granular Provider Error Classification & Emergency Compaction', () => {
  describe('classifyLLMError with Provider-Specific Context Overflow Patterns', () => {
    it('classifies Google Gemini token limit exceeded errors', () => {
      // Pattern 1: Typical Gemini 400 error message
      const geminiError1 = new Error(
        'The input token count (1050000) exceeds the maximum number of tokens allowed (1048576).',
      );
      const classified1 = classifyLLMError(geminiError1);
      assert.equal(classified1.kind, 'CONTEXT_LENGTH_EXCEEDED');
      assert.equal(classified1.retryable, false);
      assert.equal(classified1.statusCode, 400);

      // Pattern 2: Gemini gRPC / REST INVALID_ARGUMENT format
      const geminiError2 = {
        message: 'Invalid argument: token count exceeds limit for models/gemini-2.5-flash',
        status: 400,
      };
      const classified2 = classifyLLMError(geminiError2);
      assert.equal(classified2.kind, 'CONTEXT_LENGTH_EXCEEDED');
      assert.equal(classified2.retryable, false);

      // Pattern 3: Gemini input token count
      const geminiError3 = new Error(
        '[GoogleGenerativeAI Error]: the input token count exceeds the maximum allowed for this model',
      );
      const classified3 = classifyLLMError(geminiError3);
      assert.equal(classified3.kind, 'CONTEXT_LENGTH_EXCEEDED');
      assert.equal(classified3.retryable, false);
    });

    it('classifies DeepSeek & OpenAI-compatible context length errors', () => {
      // Pattern 1: OpenAI/DeepSeek code: context_length_exceeded
      const deepseekError1 = {
        message: 'This model\'s maximum context length is 65536 tokens. However, your messages resulted in 70000 tokens.',
        code: 'context_length_exceeded',
        status: 400,
      };
      const classified1 = classifyLLMError(deepseekError1);
      assert.equal(classified1.kind, 'CONTEXT_LENGTH_EXCEEDED');
      assert.equal(classified1.retryable, false);
      assert.equal(classified1.statusCode, 400);

      // Pattern 2: Typical OpenAI prompt length message
      const deepseekError2 = new Error(
        'Please reduce the length of the messages or completion. (request contains too many tokens)',
      );
      const classified2 = classifyLLMError(deepseekError2);
      assert.equal(classified2.kind, 'CONTEXT_LENGTH_EXCEEDED');
      assert.equal(classified2.retryable, false);

      // Pattern 3: Nested error object from DeepSeek API
      const deepseekError3 = {
        message: 'LLM API error (400): {"error":{"message":"maximum context length exceeded","type":"invalid_request_error","code":"context_length_exceeded"}}',
        status: 400,
      };
      const classified3 = classifyLLMError(deepseekError3);
      assert.equal(classified3.kind, 'CONTEXT_LENGTH_EXCEEDED');
      assert.equal(classified3.retryable, false);
    });

    it('does not misclassify rate limits or server errors as context overflow', () => {
      const rateLimitError = new Error('Rate limit exceeded: 429 Too Many Requests. TPM limit reached.');
      assert.equal(classifyLLMError(rateLimitError).kind, 'TRANSIENT_RATE_LIMIT');

      const serverError = new Error('503 Service Unavailable: High demand');
      assert.equal(classifyLLMError(serverError).kind, 'SERVER_ERROR');
    });
  });

  describe('DeepseekLLM Error Attributes', () => {
    it('attaches status and parses error body on HTTP 400', async () => {
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async () => {
          return new Response(
            JSON.stringify({
              error: {
                message: 'Context length exceeded maximum limit of 64k tokens',
                type: 'invalid_request_error',
                code: 'context_length_exceeded',
              },
            }),
            { status: 400, statusText: 'Bad Request' },
          );
        };

        const llm = new DeepseekLLM('fake-api-key', 'deepseek-chat', 'https://api.deepseek.com');
        const session = new Session('test-deepseek-error');
        session.addUserMessage('Hello');

        let caughtError: any;
        try {
          await llm.generateStream(session, []);
        } catch (err: any) {
          caughtError = err;
        }

        assert.ok(caughtError, 'Expected generateStream to throw an error');
        assert.equal(caughtError.status, 400);
        assert.equal(caughtError.code, 'context_length_exceeded');
        assert.equal(caughtError.type, 'invalid_request_error');

        // Verify classifyLLMError on caught error
        const classified = classifyLLMError(caughtError);
        assert.equal(classified.kind, 'CONTEXT_LENGTH_EXCEEDED');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('AgentLoop Emergency Compaction on Context Length Exceeded', () => {
    it('triggers emergency compaction and recovers execution turn', async () => {
      let callCount = 0;
      const mockLLM = {
        modelName: 'mock-llm',
        getTokenConfig: () => ({ maxInputTokens: 10000 }),
        generateStream: async (session: Session) => {
          callCount++;
          if (callCount === 1) {
            // First call fails with Gemini/DeepSeek context overflow
            const err: any = new Error(
              'The input token count (12000) exceeds the maximum number of tokens allowed (10000).',
            );
            err.status = 400;
            throw err;
          }
          // Second call succeeds after emergency compaction
          return {
            text: 'Turn successfully recovered after emergency compaction!',
            toolCalls: [],
            finishReason: 'stop',
          };
        },
      };

      const workspace = new Workspace(process.cwd());
      const registry = new ToolRegistry();
      const loop = new AgentLoop(mockLLM as any, registry, { workspace });

      const session = new Session('test-emergency-compaction');
      session.addUserMessage('Start long task');

      // Populate some multi-turn history to simulate high token count
      for (let i = 1; i <= 5; i++) {
        session.addUserMessage(`User question ${i}`);
        session.addModelMessage({ text: `Step ${i} execution details with lengthy output... `.repeat(50) });
      }
      session.addUserMessage('Continue execution');

      const result = await loop.run(session);

      assert.equal(callCount, 2, 'LLM should be called twice: 1st fails with overflow, 2nd succeeds after compaction');
      assert.ok(result.includes('Turn successfully recovered'), 'Execution turn should complete successfully');

      // Verify that a session/compaction event was recorded
      const compactionEvents = session.getEvents().filter((e) => e.type === 'session/compaction');
      assert.ok(compactionEvents.length > 0, 'An emergency compaction event should be recorded in session event log');
      assert.equal(
        compactionEvents[compactionEvents.length - 1].data.reason,
        'emergency-compaction-context-overflow',
      );
    });
  });
});
