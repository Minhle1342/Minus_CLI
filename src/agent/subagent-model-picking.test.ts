import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AgentLoop } from './agent-loop.js';
import { Session } from '../session/session.js';
import { ToolRegistry } from '../tools/registry.js';
import { Workspace } from '../workspace/workspace.js';
import { createModelsTool, createSpawnAgentTool, createDelegateTaskTool } from '../tools/subagent-tools.js';
import { SubagentManager } from './subagent-manager.js';
import { AgentRegistry } from './agent-registry.js';

process.env.NODE_ENV = 'test';

describe('Subagent Model Picking & Skip Warming Suite (OpenCode v2.0.5 & v2.0.6 Parity)', () => {
  const workspace = new Workspace(process.cwd());

  it('1. models tool lists catalog and supports query filtering', async () => {
    const modelsTool = createModelsTool();
    const all = await modelsTool.execute({}, workspace);
    assert.equal(all.success, true);
    assert.ok(Array.isArray(all.models));
    assert.ok(all.total > 0);

    const filtered = await modelsTool.execute({ query: 'flash' }, workspace);
    assert.equal(filtered.success, true);
    assert.ok(filtered.models.length > 0);
    assert.ok(filtered.models.every((m: any) =>
      m.name.toLowerCase().includes('flash')
      || m.id.toLowerCase().includes('flash')
      || m.description.toLowerCase().includes('flash')
      || m.provider.toLowerCase().includes('flash')
    ));
  });

  it('2. Subagent inherits childLLM with picked model instead of parent model', async () => {
    let childCreatedWithModel: string | undefined;

    const parentLLM = {
      modelName: 'deepseek-reasoner',
      baseURL: 'https://api.deepseek.com',
      apiKey: 'sk-parent-key',
      systemPrompt: 'parent system',
      getTokenConfig: () => ({ maxInputTokens: 128000, maxOutputTokens: 8000 }),
      cloneWithModel: (modelName: string) => {
        childCreatedWithModel = modelName;
        return {
          modelName,
          baseURL: 'https://api.deepseek.com',
          apiKey: 'sk-parent-key',
          systemPrompt: 'child system',
          getTokenConfig: () => ({ maxInputTokens: 128000, maxOutputTokens: 8000 }),
          generateStream: async () => ({
            text: 'Subtask result completed with fast model.',
            toolCalls: [],
            finishReason: 'stop',
          }),
        };
      },
      generateStream: async () => ({
        text: 'Parent answer.',
        toolCalls: [],
        finishReason: 'stop',
      }),
    };

    const agentRegistry = new AgentRegistry();
    let subagentManager: SubagentManager;
    const loop = new AgentLoop(parentLLM as any, new ToolRegistry(), { workspace, agentRegistry });
    subagentManager = (loop as any).subagentManager;

    const delegateTool = createDelegateTaskTool(subagentManager);
    const session = new Session('session-parent-model-pick');
    subagentManager.bindSession(session);

    const result = await delegateTool.execute({
      task: 'Check quick syntax',
      model: 'deepseek-chat',
    }, workspace);

    assert.equal(result.success, true);
    assert.equal(childCreatedWithModel, 'deepseek-chat', 'Child loop must be instantiated with picked model');
    assert.ok(String(result.summary).includes('completed with fast model'));
  });

  it('3. Subagent skips session warming and does not inject project knowledge base digest into child history', async () => {
    const mockChildLLM = {
      modelName: 'gemini-2.5-flash',
      getTokenConfig: () => ({ maxInputTokens: 128000, maxOutputTokens: 8000 }),
      generateStream: async () => ({
        text: 'Clean execution without warming overhead.',
        toolCalls: [],
        finishReason: 'stop',
      }),
    };

    const agentRegistry = new AgentRegistry();
    const parentLLM = {
      modelName: 'gemini-3.7-flash',
      getTokenConfig: () => ({ maxInputTokens: 128000, maxOutputTokens: 8000 }),
      cloneWithModel: () => mockChildLLM,
      generateStream: async () => ({ text: 'Parent', toolCalls: [], finishReason: 'stop' }),
    };

    const loop = new AgentLoop(parentLLM as any, new ToolRegistry(), { workspace, agentRegistry });
    const subagentManager = (loop as any).subagentManager as SubagentManager;

    const parentSession = new Session('session-parent-warming');
    subagentManager.bindSession(parentSession);

    const spawnTool = createSpawnAgentTool(subagentManager);
    const spawnRes = await spawnTool.execute({
      brief: 'Inspect small helper function',
      model: 'gemini-2.5-flash',
    }, workspace);

    assert.equal(spawnRes.success, true);
    const agentId = spawnRes.agentId;

    const handle = await subagentManager.waitFor(agentId, 5000);
    assert.equal(handle.status, 'completed');

    const executionSession = subagentManager.getExecutionSession(agentId);
    assert.ok(executionSession, 'Child execution session must exist');

    const history = executionSession.getHistory();
    // Warm-start knowledge base must be skipped for subagents (OpenCode v2.0.6 PR #49387)
    const hasWarmStartMemory = history.some((msg) =>
      msg.parts?.some((p: any) => String(p.text || '').includes('[PROJECT KNOWLEDGE BASE - WARM START MEMORY]'))
    );
    assert.equal(hasWarmStartMemory, false, 'Subagent must skip project memory warm start');
  });
});
