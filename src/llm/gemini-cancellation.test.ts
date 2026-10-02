import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiLLM } from './gemini.js';
import { retryWithExponentialBackoff } from './error-handling.js';
import { Session } from '../session/session.js';
import { AgentLoop } from '../agent/agent-loop.js';
import { ToolRegistry } from '../tools/registry.js';
import { Workspace } from '../workspace/workspace.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const rejectAbort = () => reject(new DOMException('Request aborted', 'AbortError'));
    if (signal.aborted) rejectAbort();
    else signal.addEventListener('abort', rejectAbort, { once: true });
  });
}

async function finishesPromptly<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Cancellation did not finish promptly')), 1000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('Gemini cancellation while thinking', () => {
  it('aborts the SDK request while waiting for the first response', async () => {
    const controller = new AbortController();
    const llm = new GeminiLLM('test-key');
    let calls = 0;
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    (llm as any).client = {
      models: {
        generateContentStream: async ({ config }: any) => {
          calls++;
          assert.equal(config.abortSignal, controller.signal);
          requestStarted();
          await waitForAbort(config.abortSignal);
        },
      },
    };

    const result = llm.generateStream(new Session('cancel-before-first-token'), [], undefined, { signal: controller.signal });
    try {
      await finishesPromptly(started);
      controller.abort();
      assert.equal((await finishesPromptly(result)).finishReason, 'aborted');
      assert.equal(calls, 1, 'an aborted request must not be retried');
    } finally {
      controller.abort();
    }
  });

  it('aborts the SDK stream while waiting after a thinking token', async () => {
    const controller = new AbortController();
    const llm = new GeminiLLM('test-key');
    let calls = 0;
    let receivedThought!: () => void;
    const thoughtSeen = new Promise<void>((resolve) => { receivedThought = resolve; });
    (llm as any).client = {
      models: {
        generateContentStream: async ({ config }: any) => {
          calls++;
          assert.equal(config.abortSignal, controller.signal);
          return (async function* () {
            yield { candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }] } }] };
            await waitForAbort(config.abortSignal);
          })();
        },
      },
    };

    const result = llm.generateStream(new Session('cancel-after-thought'), [], {
      onThoughtToken: receivedThought,
    }, { signal: controller.signal });
    try {
      await finishesPromptly(thoughtSeen);
      controller.abort();
      assert.equal((await finishesPromptly(result)).finishReason, 'aborted');
      assert.equal(calls, 1, 'an aborted stream must not be retried');
    } finally {
      controller.abort();
    }
  });

  it('closes the agent step and turn as cancelled when Gemini thinking is aborted', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-cancel-'));
    const controller = new AbortController();
    try {
      const llm = new GeminiLLM('test-key');
      let requestStarted!: () => void;
      const started = new Promise<void>((resolve) => { requestStarted = resolve; });
      (llm as any).client = {
        models: {
          generateContentStream: async ({ config }: any) => {
            requestStarted();
            await waitForAbort(config.abortSignal);
          },
        },
      };
      const loop = new AgentLoop(llm, new ToolRegistry(), { workspace: new Workspace(root), maxSteps: 2 });
      const session = new Session('cancel-gemini-agent-turn');
      const result = loop.submit(session, 'Investigate a bug', 'human', { signal: controller.signal });
      await finishesPromptly(started);
      controller.abort();
      assert.match(await finishesPromptly(result), /cancellation requested/i);
      session.assertRuntimeInvariants();
      assert.equal([...session.getEvents()].reverse().find((event) => event.type === 'step/end')?.data.reason, 'cancelled');
      assert.equal([...session.getEvents()].reverse().find((event) => event.type === 'turn/end')?.data.reason, 'cancelled');
    } finally {
      controller.abort();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    }
  });
});

describe('LLM retry cancellation', () => {
  it('interrupts a transient-error backoff without another attempt', async () => {
    const controller = new AbortController();
    let attempts = 0;
    let retryScheduled!: () => void;
    const scheduled = new Promise<void>((resolve) => { retryScheduled = resolve; });
    const result = retryWithExponentialBackoff(async () => {
      attempts++;
      throw new Error('LLM API error (503): temporarily unavailable');
    }, { signal: controller.signal, baseDelayMs: 30_000, maxDelayMs: 30_000, jitterMs: 0, onRetry: retryScheduled });

    await finishesPromptly(scheduled);
    await new Promise((resolve) => setTimeout(resolve, 20)); // abort during the backoff, not before it starts
    assert.equal(attempts, 1);
    controller.abort();
    await assert.rejects(finishesPromptly(result), { name: 'AbortError' });
    assert.equal(attempts, 1);
  });

  it('does not retry an AbortError even without a signal', async () => {
    let attempts = 0;
    await assert.rejects(retryWithExponentialBackoff(async () => {
      attempts++;
      throw new DOMException('Request aborted', 'AbortError');
    }), { name: 'AbortError' });
    assert.equal(attempts, 1);
  });

  it('still retries transient provider failures when not cancelled', async () => {
    let attempts = 0;
    const result = await retryWithExponentialBackoff(async () => {
      if (++attempts === 1) throw new Error('LLM API error (503): temporarily unavailable');
      return 'recovered';
    }, { maxRetries: 1, sleepFn: async () => {} });
    assert.equal(result, 'recovered');
    assert.equal(attempts, 2);
  });
});
