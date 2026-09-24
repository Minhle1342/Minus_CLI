import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Session } from '../session/session.js';
import { ToolRegistry } from '../tools/registry.js';
import { Workspace } from '../workspace/workspace.js';
import { AgentLoop } from './agent-loop.js';

test('AgentLoop attaches a pre-edit command proof to the model-visible failed result', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-attribution-loop-'));
  try {
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'legacy.ts'), 'const legacy: number = "bad";');
    await fs.writeFile(path.join(root, 'src', 'changed.ts'), 'export const value = 1;');
    const registry = new ToolRegistry();
    registry.register({
      name: 'run_command', description: 'Run verification.',
      parameters: { type: 'OBJECT', properties: { command: { type: 'STRING' } }, required: ['command'] } as any,
      execute: async () => ({ success: false, commandOutcome: 'failed_unexpected', exitCode: 2, sandbox: 'local',
        executionTarget: 'host', stdout: "src/legacy.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.", stderr: '' }),
    });
    registry.register({
      name: 'replace_text', description: 'Update a source file.',
      parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' }, oldText: { type: 'STRING' }, newText: { type: 'STRING' } },
        required: ['path', 'oldText', 'newText'] } as any,
      execute: async (args) => {
        const file = path.join(root, String(args.path));
        await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace(String(args.oldText), String(args.newText)));
        return { success: true, path: args.path, replacements: 1 };
      },
    });
    const replies = [
      { toolCalls: [{ id: 'baseline', name: 'run_command', args: { command: 'npm run build' } }] },
      { toolCalls: [{ id: 'edit', name: 'replace_text', args: { path: 'src/changed.ts', oldText: '1', newText: '2' } }] },
      { toolCalls: [{ id: 'post', name: 'run_command', args: { command: 'npm run build' } }] },
      ...Array.from({ length: 6 }, () => ({ text: 'The same build diagnostic already existed before the edit in src/legacy.ts. Verification remains blocked.', toolCalls: [] })),
    ];
    const llm = { modelName: 'scripted', generate: async () => replies.shift() || { text: 'Verification remains blocked.', toolCalls: [] } };
    const session = new Session();
    session.addUserMessage('Update src/changed.ts from value 1 to 2, then run npm run build.');
    const loop = new AgentLoop(llm, registry, { maxSteps: 4, workspace: new Workspace(root),
      toolControlMode: 'off', enableDynamicToolRetrieval: false, enableStepSummarization: false,
      enableGraphRepositoryMap: false, enableRepositoryMemory: false, enableDynamicContextCache: false });
    await loop.run(session);
    const results = session.getEvents().filter((event) => event.type === 'tool/result' && event.data.toolName === 'run_command');
    assert.equal(results.length, 2);
    assert.equal(results[1].data.result?.regressionEvidence?.classification, 'pre_existing_out_of_scope');
    assert.equal(results[1].data.result?.success, false, 'an old failure must not count as passing verification');
    assert.equal(session.getEvents().some((event) => event.data.controlDecision?.commandBaseline), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
