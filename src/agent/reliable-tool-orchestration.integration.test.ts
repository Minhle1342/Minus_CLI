import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Session } from '../session/session.js';
import { ToolRegistry } from '../tools/registry.js';
import { Workspace } from '../workspace/workspace.js';
import { AgentLoop } from './agent-loop.js';

class OrchestrationFollowingLLM {
  readonly requests: string[][] = [];
  private index = 0;
  readonly modelName = 'orchestration-script';
  private readonly replies = [
    { toolCalls: [{ id: 'search-1', name: 'search_codebase_fast', args: { query: 'Service.run' } }] },
    { toolCalls: [{ id: 'context-1', name: 'get_symbol_context_360', args: { symbol: 'Service.run', path: 'src/service.ts' } }] },
    { toolCalls: [{ id: 'read-1', name: 'read_file', args: { path: 'src/service.ts', symbol: 'Service.run' } }] },
    { toolCalls: [{ id: 'impact-1', name: 'analyze_impact', args: { target: 'Service.run', direction: 'upstream' } }] },
    { text: 'Service.run validates the input before returning it; its caller and targeted test were identified from graph context.', toolCalls: [] },
  ];

  getTokenConfig(): Record<string, number> {
    return { maxInputTokens: 32_000, maxOutputTokens: 2_000 };
  }

  async generate(_session: Session, tools: any[]): Promise<any> {
    this.requests.push(tools.map((tool) => String(tool.name)));
    const reply = this.replies[this.index++];
    assert.ok(reply, 'unexpected extra orchestration model request');
    return reply;
  }
}

test('AgentLoop enforce mode exposes the broad-to-narrow retrieval path and records telemetry', async () => {
  const originalMode = process.env.MINUS_RELIABLE_TOOL_ORCHESTRATION;
  process.env.MINUS_RELIABLE_TOOL_ORCHESTRATION = 'enforce';
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-orchestration-loop-'));
  try {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'service.ts'), 'export class Service { run(value: string) { return value; } }');
    const registry = new ToolRegistry();
    const register = (name: string, execute: (args: any) => any): void => registry.register({
      name,
      description: `${name} integration fixture`,
      parameters: { type: 'OBJECT', properties: {} } as any,
      execute: async (args: any) => execute(args),
    });
    register('search_codebase_fast', () => ({ hits: [{ path: 'src/service.ts', symbol: 'Service.run' }] }));
    register('read_compressed_code', () => ({ segments: [{ path: 'src/service.ts', symbol: 'Service.run', fidelity: 'full' }] }));
    register('get_symbol_context_360', () => ({
      success: true,
      context360: {
        symbol: 'Service.run',
        file: 'src/service.ts',
        callers: [{ name: 'main', file: 'src/index.ts', line: 2 }],
        callees: [],
        relatedTests: [{ file: 'src/service.test.ts', line: 3, preview: 'run' }],
      },
    }));
    register('read_file', () => ({
      path: 'src/service.ts',
      symbol: 'Service.run',
      completeDeclaration: true,
      content: 'export class Service { run(value: string) { return value; } }',
    }));
    register('analyze_impact', () => ({ risk: 'LOW', directCallers: 1, affectedProcesses: [] }));
    register('query_call_graph', () => ({ callers: [], callees: [] }));

    const llm = new OrchestrationFollowingLLM();
    const loop = new AgentLoop(llm, registry, {
      workspace: new Workspace(root),
      maxSteps: 7,
      toolControlMode: 'off',
      stepPromptGatingMode: 'enforce',
      enableDynamicToolRetrieval: false,
      enableStepSummarization: false,
      enableGraphRepositoryMap: false,
      enableRepositoryMemory: false,
      enableDynamicContextCache: false,
    });
    const session = new Session('reliable-orchestration-integration');
    session.addUserMessage('Explain how Service.run works and identify its blast radius.');
    const answer = await loop.run(session);

    const toolSequence = session.getEvents()
      .filter((event) => event.type === 'tool/call')
      .map((event) => String(event.data.toolName));
    assert.deepEqual(toolSequence, [
      'search_codebase_fast',
      'get_symbol_context_360',
      'read_file',
      'analyze_impact',
    ]);
    assert.match(answer, /Service\.run/);
    assert.equal(llm.requests[1].includes('search_codebase_fast'), false);
    assert.equal(llm.requests[1].includes('get_symbol_context_360'), true);
    assert.equal(llm.requests[2].includes('read_file'), true);
    assert.equal(llm.requests[2].includes('search_codebase_fast'), false);
    assert.equal(llm.requests[3].includes('analyze_impact'), true);
    assert.equal(llm.requests[3].includes('read_file'), false);

    const decisions: any[] = session.getEvents()
      .map((event) => event.data.controlDecision)
      .filter((decision): decision is any => Boolean(decision?.kind === 'reliable-tool-orchestration'));
    assert.ok(decisions.length >= 4);
    assert.deepEqual(decisions.slice(0, 4).map((decision) => decision.route.stage), [
      'broad_discovery',
      'symbol_context',
      'exact_implementation',
      'ready_for_mutation',
    ]);
    const telemetry = loop.reliableToolOrchestrationTelemetry.snapshot();
    assert.equal(telemetry.followed, 4);
    assert.equal(telemetry.invalidCycles, 0);
  } finally {
    if (originalMode === undefined) delete process.env.MINUS_RELIABLE_TOOL_ORCHESTRATION;
    else process.env.MINUS_RELIABLE_TOOL_ORCHESTRATION = originalMode;
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

class GuardrailTestingLLM {
  private index = 0;
  readonly modelName = 'guardrail-script';
  private readonly replies = [
    // 1. LLM attempts prohibited git push (ACI blocks)
    { toolCalls: [{ id: 'push-1', name: 'run_command', args: { command: 'git push origin main' } }] },
    // 2. LLM attempts mutation without reproduction test (Reproduction Gate blocks)
    { toolCalls: [{ id: 'edit-1', name: 'replace_text', args: { path: 'src/service.ts', searchContent: 'return value;', replaceWith: 'return "fixed";' } }] },
    // 3. LLM executes reproduction test that fails (establishes reproduction proof)
    { toolCalls: [{ id: 'test-1', name: 'run_command', args: { command: 'npm test -- --filter=service' } }] },
    // 4. LLM reads the exact target file to acquire evidence
    { toolCalls: [{ id: 'read-1', name: 'read_file', args: { path: 'src/service.ts' } }] },
    // 5. LLM attempts mutation again (now allowed because reproduction proof exists and file is examined)
    { toolCalls: [{ id: 'edit-2', name: 'replace_text', args: { path: 'src/service.ts', searchContent: 'return value;', replaceWith: 'return "fixed";' } }] },
    // 6. LLM executes post-mutation verification test (passes!)
    { toolCalls: [{ id: 'test-2', name: 'run_command', args: { command: 'npm test -- --filter=service' } }] },
    // 7. Final completion after successful verification
    { text: 'Bug successfully reproduced, patched, and verified.', toolCalls: [] },
  ];

  getTokenConfig(): Record<string, number> {
    return { maxInputTokens: 32_000, maxOutputTokens: 2_000 };
  }

  async generate(_session: Session, _tools: any[]): Promise<any> {
    const reply = this.replies[this.index++];
    assert.ok(reply, 'unexpected extra LLM call in guardrail test');
    return reply;
  }
}

test('AgentLoop enforces ACI guardrails against prohibited commands and Reproduction Gate against unverified mutations', async () => {
  const origAci = process.env.MINUS_ACI_GUARDRAILS;
  const origRepro = process.env.MINUS_REPRODUCTION_GATE;
  process.env.MINUS_ACI_GUARDRAILS = 'enforce';
  process.env.MINUS_REPRODUCTION_GATE = 'enforce';

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-guardrails-loop-'));
  try {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'service.ts'), 'export class Service { run(value: string) { return value; } }');

    let commandExecuted = '';
    let mutationExecuted = false;
    let testRuns = 0;

    const registry = new ToolRegistry();
    registry.register({
      name: 'run_command',
      description: 'run_command fixture',
      parameters: { type: 'OBJECT', properties: {} } as any,
      execute: async (args: any) => {
        commandExecuted = args.command;
        if (args.command?.includes('npm test')) {
          testRuns++;
          if (testRuns === 1) {
            // First run: reproduction test fails
            return { exitCode: 1, error: 'Test failed: expected "fixed" but got "value"' };
          }
          // Second run: verification test passes
          return { exitCode: 0, stdout: 'All 1 test passed!' };
        }
        return { exitCode: 0 };
      },
    });
    registry.register({
      name: 'read_file',
      description: 'read_file fixture',
      parameters: { type: 'OBJECT', properties: {} } as any,
      execute: async (_args: any) => ({
        path: 'src/service.ts',
        content: 'export class Service { run(value: string) { return value; } }',
      }),
    });
    registry.register({
      name: 'replace_text',
      description: 'replace_text fixture',
      parameters: { type: 'OBJECT', properties: {} } as any,
      execute: async (_args: any) => {
        mutationExecuted = true;
        return { success: true };
      },
    });

    const llm = new GuardrailTestingLLM();
    const loop = new AgentLoop(llm, registry, {
      workspace: new Workspace(root),
      maxSteps: 10,
      toolControlMode: 'off',
      stepPromptGatingMode: 'off',
      enableDynamicToolRetrieval: false,
      enableStepSummarization: false,
      enableGraphRepositoryMap: false,
      enableRepositoryMemory: false,
      enableDynamicContextCache: false,
    });

    const session = new Session('guardrails-integration');
    session.addUserMessage('Fix the bug in Service.run where return value is wrong.');
    const answer = await loop.run(session);

    assert.match(answer, /Bug successfully reproduced/);

    const toolEvents = session.getEvents().filter((e) => e.type === 'tool/result');
    // Call 1 (git push) was blocked by ACI
    assert.equal(toolEvents[0].data.result?.reasonCode, 'PROHIBITED_PUSH_TO_MAIN');
    // Call 2 (replace_text) was blocked by Reproduction Gate
    assert.equal(toolEvents[1].data.result?.reasonCode, 'REPRODUCTION_GATE_BLOCKED');
    // Call 3 (run_command test) executed and established reproduction proof
    assert.equal(toolEvents[2].data.result?.exitCode, 1);
    // Call 4 (read_file) examined the target file
    assert.equal(toolEvents[3].data.result?.path, 'src/service.ts');
    // Call 5 (replace_text) was permitted and executed
    assert.equal(toolEvents[4].data.result?.success, true);
    assert.equal(mutationExecuted, true);
    // Call 6 (verification test) passed!
    assert.equal(toolEvents[5].data.result?.exitCode, 0);
  } finally {
    if (origAci === undefined) delete process.env.MINUS_ACI_GUARDRAILS;
    else process.env.MINUS_ACI_GUARDRAILS = origAci;
    if (origRepro === undefined) delete process.env.MINUS_REPRODUCTION_GATE;
    else process.env.MINUS_REPRODUCTION_GATE = origRepro;
    await fs.rm(root, { recursive: true, force: true });
  }
});
