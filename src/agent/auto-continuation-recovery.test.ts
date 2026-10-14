import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AgentLoop } from './agent-loop.js';
import { Session } from '../session/session.js';
import { ToolRegistry } from '../tools/registry.js';
import { Workspace } from '../workspace/workspace.js';
import type { LLMResponse } from '../llm/gemini.js';

process.env.NODE_ENV = 'test';

describe('Incomplete Session Auto-Continuation Suite (OpenCode v2.0.8 Parity)', () => {
  const workspace = new Workspace(process.cwd());

  it('1. Automatically recovers from transport_eof by injecting continuation prompt and completing task', async () => {
    let callCount = 0;
    const mockLLM = {
      modelName: 'mock-deepseek-r1',
      baseURL: 'https://api.deepseek.com',
      systemPrompt: 'You are an assistant',
      getTokenConfig: () => ({ maxInputTokens: 128000, maxOutputTokens: 8000 }),
      generateStream: async (_session: Session): Promise<LLMResponse> => {
        callCount++;
        if (callCount === 1) {
          // Lần gọi 1: Bị stall giữa chừng bởi Watchdog -> finishReason: 'transport_eof'
          return {
            text: 'I started writing the code: function compute() {',
            reasoningContent: 'Thinking about the implementation...',
            toolCalls: [],
            finishReason: 'transport_eof',
            rawFinishReason: 'transport_eof',
          };
        }
        // Lần gọi 2: Auto-continuation tiếp tục mạch làm việc và hoàn thành
        return {
          text: 'return 42; } // Completed!',
          toolCalls: [],
          finishReason: 'stop',
          rawFinishReason: 'stop',
        };
      },
    };

    const registry = new ToolRegistry();
    const loop = new AgentLoop(mockLLM as any, registry, { workspace });
    const session = new Session('session-auto-continue-test');
    session.addUserMessage('Please write the compute function.');

    const result = await loop.run(session);

    assert.equal(callCount, 2, 'Must have automatically re-invoked LLM via continuation');
    const history = session.getHistory();

    // Kiểm tra lịch sử có đúng các lượt tin nhắn được nối tiếp
    const modelMessages = history.filter((m) => m.role === 'model');
    assert.ok(modelMessages.length >= 2, 'Both partial and final model outputs must be recorded');
    assert.equal(modelMessages[0].parts?.[0]?.text, 'I started writing the code: function compute() {');

    // Kiểm tra tin nhắn system continuation đã được thêm
    const systemContinuation = history.find((m) =>
      m.role === 'user' && m.parts?.some((p: any) => String(p.text).includes('[STREAM CONNECTION INTERRUPTED')),
    );
    assert.ok(systemContinuation, 'Continuation prompt must be injected into history');
    assert.ok(String(result).includes('return 42;'), 'Final answer must contain completed output');
  });

  it('2. Maintains alternating role invariant even when stream is interrupted with zero text', async () => {
    let callCount = 0;
    const mockLLM = {
      modelName: 'mock-reasoning-model',
      baseURL: 'https://api.deepseek.com',
      systemPrompt: 'You are an assistant',
      getTokenConfig: () => ({ maxInputTokens: 128000, maxOutputTokens: 8000 }),
      generateStream: async (_session: Session): Promise<LLMResponse> => {
        callCount++;
        if (callCount === 1) {
          // Ngắt kết nối ngay trong giai đoạn reasoning, chưa nhả token text nào
          return {
            text: undefined,
            reasoningContent: 'Thinking hard...',
            toolCalls: [],
            finishReason: 'transport_eof',
            rawFinishReason: 'transport_eof',
          };
        }
        return {
          text: 'Recovered answer.',
          toolCalls: [],
          finishReason: 'stop',
          rawFinishReason: 'stop',
        };
      },
    };

    const registry = new ToolRegistry();
    const loop = new AgentLoop(mockLLM as any, registry, { workspace });
    const session = new Session('session-empty-text-interruption');
    session.addUserMessage('Do reasoning task.');

    await loop.run(session);

    const history = session.getHistory();
    // Đảm bảo không có 2 user message liên tiếp
    for (let i = 0; i < history.length - 1; i++) {
      const currentRole = history[i].role;
      const nextRole = history[i + 1].role;
      if (currentRole === 'user' && nextRole === 'user') {
        assert.fail(`History violated role alternation at index ${i}: two consecutive user messages`);
      }
    }
  });
});
