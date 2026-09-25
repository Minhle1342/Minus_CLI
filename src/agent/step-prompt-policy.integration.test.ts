import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Session } from '../session/session.js';
import { ToolRegistry } from '../tools/registry.js';
import { Workspace } from '../workspace/workspace.js';
import { AgentLoop } from './agent-loop.js';
import type { StepPromptGatingMode } from './step-prompt-policy.js';
import type { ToolControlMode } from '../control/classification-types.js';

const finalSummary = [
  'Implemented the requested configuration update after reading the original value.',
  'The mutation changed sample.txt from before to after and remained limited to that file.',
  'Verification ran through the scripted npm test command and returned exit code 0.',
  'The resulting session contains durable read, mutation, verification, and submission evidence.',
].join(' ');

class PromptCapturingScriptedLLM {
  readonly requests: Array<{ systemPrompt: string; dynamicContext: string; tools: string[] }> = [];
  private index = 0;

  readonly replies = [
    { finishReason: 'tool_calls', toolCalls: [{ id: 'read-1', name: 'read_file', args: { path: 'sample.txt' } }] },
    { finishReason: 'tool_calls', toolCalls: [{ id: 'edit-1', name: 'replace_text', args: { path: 'sample.txt', oldText: 'before', newText: 'after' } }] },
    { finishReason: 'tool_calls', toolCalls: [{ id: 'verify-1', name: 'run_command', args: { command: 'npm test' } }] },
    {
      finishReason: 'tool_calls',
      toolCalls: [{
        id: 'submit-1',
        name: 'submit_solution',
        args: {
          summary: finalSummary,
          filesModified: ['sample.txt'],
          verificationEvidence: 'npm test completed with exit code 0',
        },
      }],
    },
  ];

  readonly modelName = 'scripted-flash';
  getTokenConfig(): Record<string, number> {
    return { maxInputTokens: 32_000, maxOutputTokens: 2_000 };
  }

  async generate(_session: Session, tools: any[], request: any): Promise<any> {
    this.requests.push({
      systemPrompt: request?.systemPrompt || '',
      dynamicContext: request?.dynamicContext || '',
      tools: tools.map((tool) => String(tool.name)),
    });
    const reply = this.replies[this.index++];
    assert.ok(reply, 'scripted integration received an unexpected model request');
    return reply;
  }
}

async function runMode(
  mode: StepPromptGatingMode,
  userRequest = 'Update sample.txt from before to after and verify the change.',
  toolControlMode: ToolControlMode = 'off',
  useTestSuite = false,
): Promise<{
  finalAnswer: string;
  toolSequence: string[];
  fileContent: string;
  failedToolResults: number;
  guardianInterventions: number;
  promptTokensBefore: number;
  promptTokensAfter: number;
  requests: PromptCapturingScriptedLLM['requests'];
  phaseEvents: string[];
  classifications: string[];
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `minus-prompt-gating-${mode}-`));
  try {
    await fs.writeFile(path.join(root, 'sample.txt'), 'before', 'utf8');
    const workspace = new Workspace(root);
    const registry = new ToolRegistry();
    registry.register({
      name: 'read_file',
      description: 'Read one workspace file.',
      parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } }, required: ['path'] } as any,
      execute: async (args: Record<string, any>) => ({
        success: true,
        path: args.path,
        content: await fs.readFile(path.join(root, String(args.path)), 'utf8'),
      }),
    });
    registry.register({
      name: 'replace_text',
      description: 'Replace exact text in one workspace file.',
      parameters: {
        type: 'OBJECT',
        properties: {
          path: { type: 'STRING' },
          oldText: { type: 'STRING' },
          newText: { type: 'STRING' },
        },
        required: ['path', 'oldText', 'newText'],
      } as any,
      execute: async (args: Record<string, any>) => {
        const target = path.join(root, String(args.path));
        const original = await fs.readFile(target, 'utf8');
        await fs.writeFile(target, original.replace(String(args.oldText), String(args.newText)), 'utf8');
        return { success: true, path: args.path, replacements: 1 };
      },
    });
    registry.register({
      name: 'run_command',
      description: 'Run the project verification command.',
      parameters: { type: 'OBJECT', properties: { command: { type: 'STRING' } }, required: ['command'] } as any,
      execute: async (args: Record<string, any>) => ({
        success: true,
        command: args.command,
        exitCode: 0,
        output: '1 test passed',
      }),
    });
    if (useTestSuite) {
      registry.register({
        name: 'run_test_suite',
        description: 'Run project tests.',
        parameters: { type: 'OBJECT', properties: { command: { type: 'STRING' } } } as any,
        execute: async () => ({ success: true, isPassed: true, exitCode: 0, commandExecuted: 'npm test', summary: 'Tests passed' }),
      });
    }

    const llm = new PromptCapturingScriptedLLM();
    if (useTestSuite) {
      llm.replies[2] = { finishReason: 'tool_calls', toolCalls: [{ id: 'verify-1', name: 'run_test_suite', args: { command: 'npm test' } }] };
    }
    const loop = new AgentLoop(llm, registry, {
      workspace,
      maxSteps: 6,
      toolControlMode,
      enableDynamicToolRetrieval: !useTestSuite,
      stepPromptGatingMode: mode,
      enableStepSummarization: false,
      enableGraphRepositoryMap: false,
      enableRepositoryMemory: false,
      enableDynamicContextCache: false,
      enableSubmitAutoFinalization: true,
    });
    const session = new Session(`step-prompt-${mode}`);
    session.addUserMessage(userRequest);
    const finalAnswer = await loop.run(session);
    const toolSequence = session.getEvents()
      .filter((event) => event.type === 'tool/call')
      .map((event) => String(event.data.toolName));
    const failedToolResults = session.getEvents()
      .filter((event) => event.type === 'tool/result' && event.data.result?.success === false).length;
    const decisions = session.getEvents()
      .map((event) => event.data.controlDecision?.stepPromptDecision)
      .filter(Boolean);
    return {
      finalAnswer,
      toolSequence,
      fileContent: await fs.readFile(path.join(root, 'sample.txt'), 'utf8'),
      failedToolResults,
      guardianInterventions: failedToolResults,
      promptTokensBefore: decisions.reduce((sum, item) => sum + Number(item.estimatedTokensBefore || 0), 0),
      promptTokensAfter: decisions.reduce((sum, item) => sum + Number(item.injectedEstimatedTokens || 0), 0),
      requests: llm.requests,
      phaseEvents: session.getEvents().filter((event) => event.type.startsWith('phase/')).map((event) => event.type),
      classifications: session.getEvents().filter((event) => event.type === 'control/decision'
        && event.data.controlDecision?.classification).map((event) => event.data.controlDecision!.classification.phase),
    };
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

test('off and enforce preserve scripted mutation lifecycle while enforce reduces gated prompt blocks', async () => {
  const off = await runMode('off');
  const enforce = await runMode('enforce');

  assert.deepEqual(enforce.toolSequence, off.toolSequence);
  assert.deepEqual(enforce.toolSequence, ['read_file', 'replace_text', 'run_command', 'submit_solution']);
  assert.equal(off.fileContent, 'after');
  assert.equal(enforce.fileContent, 'after');
  assert.equal(enforce.finalAnswer, off.finalAnswer);
  assert.ok(enforce.finalAnswer.startsWith(finalSummary));
  assert.equal(enforce.failedToolResults, off.failedToolResults);
  assert.equal(enforce.guardianInterventions, off.guardianInterventions);
  assert.ok(enforce.promptTokensAfter < off.promptTokensAfter, 'enforce must inject fewer gated tokens');
  assert.ok(off.requests.every((request) => request.systemPrompt.includes('12. TOOL SYNERGY PLAYBOOKS:')));
  assert.ok(enforce.requests.every((request) => !request.systemPrompt.includes('12. TOOL SYNERGY PLAYBOOKS:')));
});

test('enforced mutation flow records explore, implementation and verification completion in order', async () => {
  const result = await runMode('enforce', 'Update sample.txt from before to after.', 'enforce');
  assert.equal(result.fileContent, 'after');
  assert.deepEqual(result.phaseEvents, [
    'phase/exploreCompleted', 'phase/implementationCompleted', 'phase/verificationCompleted',
  ]);
  assert.ok(result.classifications.includes('verify'));
  assert.match(result.requests[0].dynamicContext, /PHASE HANDOFF: explore → implement/);
  assert.match(result.requests[1].dynamicContext, /PHASE HANDOFF: explore → implement/);
  assert.match(result.requests[3].dynamicContext, /PHASE HANDOFF: implement → verify/);
});

test('run_test_suite completes the lifecycle with enforced tool scoping', async () => {
  const result = await runMode('enforce', 'Update sample.txt from before to after.', 'enforce', true);
  assert.equal(result.fileContent, 'after');
  assert.deepEqual(result.phaseEvents, [
    'phase/exploreCompleted', 'phase/implementationCompleted', 'phase/verificationCompleted',
  ]);
  assert.deepEqual(result.toolSequence, ['read_file', 'replace_text', 'run_test_suite', 'submit_solution']);
});

test('shadow mode does not duplicate the warm-start cognitive scaffold in its first dynamic suffix', async () => {
  const shadow = await runMode('shadow');
  assert.equal(
    shadow.requests[0]?.dynamicContext.includes('[COGNITIVE SCAFFOLD -'),
    false,
    'the warm-start full scaffold already supplies this first-step guidance',
  );
});

test('low-risk bugfix unlocks a small target-inspected edit without a mandatory hypothesis round-trip', async () => {
  const result = await runMode(
    'enforce',
    'Fix the bug in sample.txt by changing before to after, then verify the change.',
    'enforce',
  );

  assert.deepEqual(result.toolSequence, ['read_file', 'replace_text', 'run_command', 'submit_solution']);
  assert.equal(result.fileContent, 'after');
  assert.equal(result.failedToolResults, 0);
  assert.equal(result.requests[0].tools.includes('replace_text'), false, 'first uncertain step stays read-only');
  assert.equal(result.requests[1].tools.includes('replace_text'), true, 'reading the exact target exposes the bounded edit fast path');
});
