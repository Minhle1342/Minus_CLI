import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LatencyOrchestrator, resolveModelLatencyProfile } from './agent/latency-orchestrator.js';
import { ContextCompactor } from './agent/context-compactor.js';
import { AgentLoop } from './agent/agent-loop.js';
import { DynamicContextCache } from './agent/dynamic-context-cache.js';
import { partitionToolCalls, type ScheduledToolCall } from './agent/tool-execution-scheduler.js';
import { AnthropicLLM } from './llm/anthropic.js';
import { Session } from './session/session.js';
import { SessionPersistence } from './session/session-persistence.js';
import { ToolRegistry } from './tools/registry.js';
import { Workspace } from './workspace/workspace.js';

class CountingSessionPersistence extends SessionPersistence {
  private persistedSeqBySession = new Map<string, number>();
  readonly toolResultFlushSizes: number[] = [];

  override async save(session: Session): Promise<void> {
    const persistedSeq = this.persistedSeqBySession.get(session.id) || 0;
    const toolResultCount = session.getEventsAfter(persistedSeq)
      .filter((event) => event.type === 'tool/result').length;
    await super.save(session);
    this.persistedSeqBySession.set(session.id, session.seq);
    if (toolResultCount > 0) this.toolResultFlushSizes.push(toolResultCount);
  }
}

function scriptedLLM(responses: any[], modelName = 'gemini-3.5-flash'): any {
  let index = 0;
  return {
    modelName,
    getTokenConfig: () => ({ maxInputTokens: 32_000, maxOutputTokens: 2_000 }),
    generateStream: async () => responses[Math.min(index++, responses.length - 1)],
  };
}

function responseIds(session: Session): string[] {
  return session.getHistory().flatMap((message: any) => (
    (message.parts || [])
      .filter((part: any) => part.functionResponse)
      .map((part: any) => String(part.functionResponse.id))
  ));
}

async function main(): Promise<void> {
  assert.deepEqual(resolveModelLatencyProfile('gemini-3.5-flash'), {
    tier: 'fast', targetMs: 20_000, reason: 'fast/flash model profile',
  });
  assert.equal(resolveModelLatencyProfile('claude-sonnet-5').targetMs, 45_000);
  assert.equal(resolveModelLatencyProfile('gemini-3.5-pro').tier, 'standard');
  assert.equal(resolveModelLatencyProfile('claude-opus-4.1').targetMs, 60_000);
  assert.equal(resolveModelLatencyProfile('claude-sonnet-5', { thinkingBudget: 8_000 }).tier, 'deep-reasoning');

  const orchestrator = new LatencyOrchestrator({ softStepTargetMs: 1_000, requestBudgetRatio: 0.8 });
  const footprint = orchestrator.estimateRequest({
    systemPrompt: 's'.repeat(3_800),
    tools: [{ name: 'read_file', description: 'r'.repeat(3_800) } as any],
    history: [{ role: 'user', parts: [{ text: 'h'.repeat(3_800) }] }],
    dynamicContext: 'd'.repeat(3_800),
    maxInputTokens: 5_000,
    maxOutputTokens: 1_000,
  });
  assert(footprint.nonHistoryTokens > 2_000, 'request footprint includes system, tools, and dynamic context');
  assert(footprint.pressureRatio > 0.8, 'request pressure is measured against input budget after output reserve');
  assert(orchestrator.buildGuidance({ step: 1, footprint, phase: 'explore' }).includes('no hard timeout'));
  assert(orchestrator.buildGuidance({ step: 1, footprint, phase: 'explore' }).includes('batch independent read-only tools'));
  assert(orchestrator.buildGuidance({ step: 1, footprint, phase: 'implement' }).includes('omit preamble'));
  assert(orchestrator.buildGuidance({ step: 1, footprint, phase: 'verify', verificationReady: true }).includes('submit_solution now'));
  orchestrator.record({ durationMs: 1_500 });
  assert(orchestrator.buildGuidance({ step: 2, footprint: { ...footprint, pressureRatio: 0.1 } }).includes('previous round trip'));

  const scheduled: ScheduledToolCall[] = [
    { index: 0, id: 'read-0', name: 'read_file', args: {} },
    { index: 1, id: 'search-1', name: 'search_text', args: {} },
    { index: 2, id: 'mutation-2', name: 'replace_text', args: {} },
    { index: 3, id: 'diagnostics-3', name: 'get_diagnostics', args: {} },
    { index: 4, id: 'command-4', name: 'run_command', args: {} },
  ];
  assert.deepEqual(partitionToolCalls(scheduled, true).map((part) => [part.mode, part.calls.map((call) => call.id)]), [
    ['concurrent-read', ['read-0', 'search-1']],
    ['sequential', ['mutation-2']],
    ['sequential-read', ['diagnostics-3']],
    ['sequential', ['command-4']],
  ], 'mutations and commands are strict sequential barriers');

  const memo = new DynamicContextCache<string>();
  assert.equal(memo.get('task-a'), undefined);
  memo.set('task-a', 'context-a');
  assert.equal(memo.get('task-a'), 'context-a');
  memo.invalidate();
  assert.equal(memo.get('task-a'), undefined);
  assert.deepEqual(memo.getStats(), { hits: 1, misses: 2, invalidations: 1 });

  const pairedHistory: any[] = [];
  for (let index = 0; index < 4; index++) {
    const id = `call-${index}`;
    pairedHistory.push({ role: 'model', parts: [{ functionCall: { id, name: 'read_file', args: { path: `${index}.ts` } } }] });
    pairedHistory.push({ role: 'user', parts: [{ functionResponse: { id, name: 'read_file', response: { content: 'x'.repeat(6_000), path: `${index}.ts` } } }] });
  }
  const compactor = new ContextCompactor({
    maxTotalHistoryTokens: 12_000,
    preserveLastNToolResults: 1,
    preservePrefixCache: true,
  });
  const compacted = compactor.compact(pairedHistory, {
    requestOverheadTokens: 4_000,
    outputReserveTokens: 2_000,
    triggerRatio: 0.82,
  });
  assert(compacted.stats.charsSaved > 0, 'full-request overhead triggers proactive history compaction');
  assert.equal(compacted.stats.effectiveHistoryBudgetTokens, 3_840);

  const auditSession = new Session('compact-request-header-test');
  auditSession.addUserMessage('u'.repeat(100_000));
  auditSession.append('turn/start', { turn: 1 });
  auditSession.append('step/start', { turn: 1, step: 1 });
  auditSession.recordRequestHeader({
    turn: 1,
    step: 1,
    systemPrompt: 'stable',
    tools: [{ name: 'read_file' }],
    history: auditSession.getHistory(),
  }, { compactHistory: true });
  const compactHeader = auditSession.lastEvent?.data.requestHeader;
  assert(compactHeader?.historyDigest && !compactHeader.history, 'request header stores a replay-verifiable history digest instead of duplicating history');
  const legacyHeaderBytes = Buffer.byteLength(JSON.stringify({
    turn: 1,
    step: 1,
    systemPrompt: 'stable',
    tools: [{ name: 'read_file' }],
    history: auditSession.getHistory(),
  }));
  const compactHeaderBytes = Buffer.byteLength(JSON.stringify(compactHeader));
  assert(compactHeaderBytes < legacyHeaderBytes * 0.05, 'compact request header removes repeated history payload');
  auditSession.assertRuntimeInvariants({ allowOpenLifecycle: true, verifyRequestReplay: 'latest' });
  auditSession.append('step/end', { turn: 1, step: 1, reason: 'test-complete' });
  auditSession.append('turn/end', { turn: 1, reason: 'completed' });

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-latency-'));
  try {
    const persistence = new SessionPersistence(tempRoot);
    await persistence.save(auditSession);
    auditSession.append('control/decision', { controlDecision: { mode: 'benchmark' } });
    await persistence.save(auditSession);
    await persistence.save(auditSession);
    const incrementalStartedAt = performance.now();
    for (let index = 0; index < 25; index++) {
      auditSession.append('control/decision', { controlDecision: { mode: 'benchmark', index } });
      await persistence.save(auditSession);
    }
    const incrementalSaveDurationMs = performance.now() - incrementalStartedAt;
    const loaded = await persistence.load(auditSession.id);
    assert.equal(loaded?.seq, auditSession.seq, 'cached append-only persistence remains replayable and idempotent');
    console.log(JSON.stringify({
      benchmark: 'session-hot-path',
      legacyHeaderBytes,
      compactHeaderBytes,
      headerReductionPercent: Number(((1 - compactHeaderBytes / legacyHeaderBytes) * 100).toFixed(2)),
      incrementalSaves: 25,
      incrementalSaveDurationMs: Number(incrementalSaveDurationMs.toFixed(2)),
    }));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  const concurrentRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-concurrent-reads-'));
  try {
    const registry = new ToolRegistry();
    const timing: Array<{ index: number; startedAt: number; endedAt: number }> = [];
    registry.register({
      name: 'read_file',
      description: 'delayed read benchmark',
      parameters: { type: 'OBJECT', properties: { index: { type: 'NUMBER' } }, required: ['index'] } as any,
      execute: async (args: Record<string, any>) => {
        const sample = { index: Number(args.index), startedAt: performance.now(), endedAt: 0 };
        timing.push(sample);
        await new Promise((resolve) => setTimeout(resolve, 120 - sample.index * 10));
        sample.endedAt = performance.now();
        return { success: true, index: sample.index, content: `read-${sample.index}` };
      },
    });
    const callIds = ['parallel-0', 'parallel-1', 'parallel-2', 'parallel-3'];
    const persistence = new CountingSessionPersistence(concurrentRoot);
    const loop = new AgentLoop(scriptedLLM([
      {
        finishReason: 'tool_calls',
        toolCalls: callIds.map((id, index) => ({ id, name: 'read_file', args: { index } })),
      },
      { text: 'All requested files were inspected successfully.', finishReason: 'stop' },
    ]), registry, {
      workspace: new Workspace(concurrentRoot),
      sessionPersistence: persistence,
      maxSteps: 3,
      enableStepSummarization: false,
      enableGraphRepositoryMap: false,
      enableRepositoryMemory: false,
      enableConcurrentReadTools: true,
      enableBatchSessionPersistence: true,
    });
    const session = new Session('concurrent-read-benchmark');
    session.addUserMessage('Inspect four independent files and report the result.');
    await loop.run(session);
    const readWallMs = Math.max(...timing.map((item) => item.endedAt)) - Math.min(...timing.map((item) => item.startedAt));
    const estimatedSerialMs = timing.reduce((sum, item) => sum + item.endedAt - item.startedAt, 0);
    assert(readWallMs < estimatedSerialMs * 0.55, 'four independent reads overlap instead of running serially');
    assert.deepEqual(responseIds(session).slice(0, 4), callIds, 'parallel results retain original call IDs and order');
    assert(persistence.toolResultFlushSizes.includes(4), 'four read results are durably flushed in one write');
    assert.equal(persistence.toolResultFlushSizes.filter((size) => size === 1).length, 0, 'read batch avoids per-result session writes');
    session.assertRuntimeInvariants({ verifyRequestReplay: 'all' });
    const batchDecision = session.getEventsAfter(0).find((event) => (
      event.type === 'control/decision' && event.data.controlDecision?.mode === 'read-tool-batch'
    ));
    assert.equal(batchDecision?.data.controlDecision?.executionMode, 'concurrent-read');
    console.log(JSON.stringify({
      benchmark: 'concurrent-read-tools',
      tools: timing.length,
      measuredBatchDurationMs: Number(readWallMs.toFixed(2)),
      estimatedSerialDurationMs: Number(estimatedSerialMs.toFixed(2)),
      savedMs: Number((estimatedSerialMs - readWallMs).toFixed(2)),
      sessionResultWritesBefore: timing.length,
      sessionResultWritesAfter: 1,
    }));
  } finally {
    await fs.rm(concurrentRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  const barrierRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-mutation-barrier-'));
  try {
    const registry = new ToolRegistry();
    const timeline: string[] = [];
    registry.register({
      name: 'read_file',
      description: 'ordered read',
      parameters: { type: 'OBJECT', properties: { index: { type: 'NUMBER' } }, required: ['index'] } as any,
      execute: async (args: Record<string, any>) => {
        timeline.push(`read-${args.index}-start`);
        await new Promise((resolve) => setTimeout(resolve, 25));
        timeline.push(`read-${args.index}-end`);
        return { success: true, content: String(args.index) };
      },
    });
    registry.register({
      name: 'replace_text',
      description: 'ordered mutation',
      parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } }, required: ['path'] } as any,
      execute: async (args: Record<string, any>) => {
        timeline.push('mutation-start');
        await fs.writeFile(path.join(barrierRoot, String(args.path)), 'mutated', 'utf8');
        timeline.push('mutation-end');
        return { success: true, path: args.path };
      },
    });
    const loop = new AgentLoop(scriptedLLM([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          { id: 'before', name: 'read_file', args: { index: 0 } },
          { id: 'mutation', name: 'replace_text', args: { path: 'mutation.txt' } },
          { id: 'after', name: 'read_file', args: { index: 1 } },
        ],
      },
      { text: 'The ordered mutation completed safely.', finishReason: 'stop' },
    ], 'claude-sonnet-5'), registry, {
      workspace: new Workspace(barrierRoot),
      maxSteps: 2,
      enableStepSummarization: false,
      enableConcurrentReadTools: true,
      enableGraphRepositoryMap: true,
      enableRepositoryMemory: true,
      enableDynamicContextCache: true,
    });
    let recallCount = 0;
    let repositoryMapCount = 0;
    (loop.repositoryMemory as any).recall = async () => {
      recallCount += 1;
      return { rendered: '[memo]', records: [] };
    };
    (loop.repositoryMemory as any).observeToolResult = async () => undefined;
    (loop.repositoryMap as any).renderContext = async () => {
      repositoryMapCount += 1;
      return '[map]';
    };
    const session = new Session('mutation-barrier-test');
    session.addUserMessage('Read, update, and read again in the declared order.');
    await loop.run(session);
    assert.deepEqual(timeline, [
      'read-0-start', 'read-0-end', 'mutation-start', 'mutation-end', 'read-1-start', 'read-1-end',
    ], 'mutation is never overlapped or reordered with reads');
    assert(loop.checkpointManager.getHistory().some((checkpoint) => checkpoint.description.includes('replace_text')),
      'mutation receives an immediate Shadow Git checkpoint');
    assert.equal(recallCount, 2, 'workspace mutation invalidates repository memory memo before the next provider step');
    assert.equal(repositoryMapCount, 2, 'workspace mutation invalidates repository map memo before the next provider step');
  } finally {
    await fs.rm(barrierRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-context-cache-'));
  try {
    const registry = new ToolRegistry();
    registry.register({
      name: 'read_file',
      description: 'cache read',
      parameters: { type: 'OBJECT', properties: { index: { type: 'NUMBER' } }, required: ['index'] } as any,
      execute: async (args: Record<string, any>) => ({ success: true, content: String(args.index) }),
    });
    const loop = new AgentLoop(scriptedLLM([
      { finishReason: 'tool_calls', toolCalls: [{ id: 'cache-0', name: 'read_file', args: { index: 0 } }] },
      { finishReason: 'tool_calls', toolCalls: [{ id: 'cache-1', name: 'read_file', args: { index: 1 } }] },
      { text: 'Read-only inspection complete.', finishReason: 'stop' },
    ]), registry, {
      workspace: new Workspace(cacheRoot),
      maxSteps: 4,
      enableStepSummarization: false,
      enableGraphRepositoryMap: true,
      enableRepositoryMemory: true,
      enableDynamicContextCache: true,
    });
    let recallCount = 0;
    let repositoryMapCount = 0;
    (loop.repositoryMemory as any).recall = async () => {
      recallCount += 1;
      return { rendered: '[memo]', records: [] };
    };
    (loop.repositoryMemory as any).observeToolResult = async () => undefined;
    (loop.repositoryMap as any).renderContext = async () => {
      repositoryMapCount += 1;
      return '[map]';
    };
    const session = new Session('dynamic-context-cache-test');
    session.addUserMessage('Inspect two files without changing the workspace.');
    await loop.run(session);
    assert.equal(recallCount, 1, 'repository memory is recalled once across consecutive read-only steps');
    assert.equal(repositoryMapCount, 1, 'repository graph map is rendered once when files do not change');
    const cacheStats = loop.dynamicContextCache.getStats();
    assert(cacheStats.hits >= 2 && cacheStats.misses === 1, 'dynamic context memo reports reusable read-only hits');
    console.log(JSON.stringify({
      benchmark: 'dynamic-context-cache',
      requests: 3,
      repositoryScansBefore: 3,
      repositoryScansAfter: repositoryMapCount,
      cacheHits: cacheStats.hits,
      cacheMisses: cacheStats.misses,
      cacheHitRatePercent: Number((cacheStats.hits / (cacheStats.hits + cacheStats.misses) * 100).toFixed(2)),
    }));
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  const originalFetch = globalThis.fetch;
  let capturedAnthropicBody: any;
  globalThis.fetch = (async (_input: any, init?: RequestInit) => {
    capturedAnthropicBody = JSON.parse(String(init?.body || '{}'));
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 70, output_tokens: 0 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
    return new Response(events, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  try {
    const anthropic = new AnthropicLLM({ apiKey: 'test-key', modelName: 'claude-test' });
    const anthropicSession = new Session('anthropic-cache-test');
    anthropicSession.addUserMessage('hello');
    const response = await anthropic.generateStream(anthropicSession, [], undefined, { enablePromptCaching: true });
    assert.deepEqual(capturedAnthropicBody.cache_control, { type: 'ephemeral' });
    assert.equal(response.usage?.promptTokens, 100);
    assert.equal(response.usage?.cacheReadInputTokens, 70);
    assert.equal(response.usage?.cacheHitRate, 70);
  } finally {
    globalThis.fetch = originalFetch;
  }

  let modelRequests = 0;
  const submittedSummary = 'Đã hoàn tất thay đổi an toàn, bảo toàn các cơ chế hiện hữu và xác minh toàn bộ bằng regression test với kết quả thành công.';
  const submitLLM = {
    modelName: 'provider-neutral-mock',
    getTokenConfig: () => ({ maxInputTokens: 32_000, maxOutputTokens: 2_000 }),
    generateStream: async () => {
      modelRequests++;
      return {
        toolCalls: [{ name: 'submit_solution', args: { summary: submittedSummary, verificationEvidence: 'mock exit 0' } }],
      };
    },
  };
  const registry = new ToolRegistry();
  const workspace = new Workspace(process.cwd());
  const loop = new AgentLoop(submitLLM, registry, {
    workspace,
    maxSteps: 3,
    enableStepSummarization: false,
    enableGraphRepositoryMap: false,
    enableRepositoryMemory: false,
  });
  registry.register({
    name: 'submit_solution',
    description: 'test submit',
    parameters: {
      type: 'OBJECT',
      properties: {
        summary: { type: 'STRING' },
        verificationEvidence: { type: 'STRING' },
      },
      required: ['summary', 'verificationEvidence'],
    } as any,
    execute: async (args: Record<string, any>) => ({ success: true, submitted: true, summary: args.summary }),
  });
  const finalSession = new Session('auto-finalize-test');
  finalSession.addUserMessage('Hoàn tất tác vụ');
  const finalAnswer = await loop.run(finalSession);
  assert.equal(finalAnswer, submittedSummary);
  assert.equal(modelRequests, 1, 'verified submit_solution finalizes without a redundant model request');

  console.log('Latency optimization regression suite passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
