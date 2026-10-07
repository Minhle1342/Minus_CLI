import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from './agent-loop.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerSubmitSolutionTool } from '../tools/submit-solution.js';
import { Session } from '../session/session.js';
import { Workspace } from '../workspace/workspace.js';

class ScriptedCompletionLLM {
  calls = 0;
  constructor(private readonly replies: any[]) {}
  async generate(_session: Session): Promise<any> {
    const reply = this.replies[this.calls++];
    if (!reply) {
      return { text: 'AgentLoop coordinates tools and completion.', toolCalls: [] };
    }
    return reply;
  }
}

const RICH_SUBMIT_ARGS = {
  summary:
    'Fixed null dereference crash in src/auth/login.ts by adding an early guard that rejects empty session tokens before the authenticator runs. Updated the login flow to return a clear 401 error, added regression coverage in tests/login.test.ts, and verified the full suite passes with npm test.',
  rootCause: 'authenticate() dereferenced session.token without checking for empty sessions.',
  filesModified: ['src/auth/login.ts'],
  verificationEvidence: 'npm test',
  verificationMethod: 'automated_test_pass',
  resolutionType: 'code_fix',
};

async function makeLoop(replies: any[], opts: Record<string, any> = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'submit-auto-'));
  await fs.writeFile(path.join(rootDir, 'sample.txt'), 'hello', 'utf8');
  const workspace = new Workspace(rootDir);
  const llm = new ScriptedCompletionLLM(replies);
  const registry = new ToolRegistry();
  registerSubmitSolutionTool(registry, workspace);
  let readFileExecuted = false;
  registry.register({
    name: 'replace_text',
    description: 'Replace text',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } },
      required: ['path', 'oldText', 'newText'],
    } as any,
    execute: async (args: Record<string, any>) => {
      const target = path.join(rootDir, String(args.path));
      const original = await fs.readFile(target, 'utf8');
      await fs.writeFile(target, original.replace(String(args.oldText), String(args.newText)), 'utf8');
      return { success: true, path: args.path, replacements: 1 };
    },
  });
  registry.register({
    name: 'read_file',
    description: 'Read file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } as any,
    execute: async () => {
      readFileExecuted = true;
      return { content: '# readme' };
    },
  });
  const loop = new AgentLoop(llm as any, registry, { workspace, maxSteps: 6, ...opts });
  return { rootDir, loop, llm, readFileExecuted: () => readFileExecuted };
}

const MUTATE_CALL = {
  text: '',
  toolCalls: [{ id: 'call-edit', name: 'replace_text', args: { path: 'sample.txt', oldText: 'hello', newText: 'hello world' } }],
};

test('submit_solution auto-finalizes by default: no second LLM round trip, no further tools', async () => {
  const { rootDir, loop, llm, readFileExecuted } = await makeLoop([
    MUTATE_CALL,
    { text: '', toolCalls: [{ id: 'call-submit', name: 'submit_solution', args: RICH_SUBMIT_ARGS }] },
    { text: '', toolCalls: [{ id: 'call-read', name: 'read_file', args: { path: 'README.md' } }] },
    { text: 'Unreached fallback.', toolCalls: [] },
  ]);
  try {
    const session = new Session('session-submit-auto');
    session.addUserMessage('Fix the login crash.');
    const result = await loop.run(session);
    assert.match(String(result), /null dereference crash/);
    assert.equal(llm.calls, 2, 'must finalize without another LLM round trip after submit');
    assert.equal(readFileExecuted(), false, 'no tool may run after submit');
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('blocked post-submit call finalizes from the submitted summary instead of looping', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'submit-auto-'));
  try {
    const workspace = new Workspace(rootDir);
    const llm = new ScriptedCompletionLLM([
      {
        text: '',
        toolCalls: [
          {
            id: 'call-submit',
            name: 'submit_solution',
            args: {
              summary:
                'Investigated the login crash in src/auth/login.ts and found that authenticate reads session.token without an empty-session guard, so the fix is to add the guard.',
              resolutionType: 'investigation_only',
            },
          },
          { id: 'call-read', name: 'read_file', args: { path: 'README.md' } },
        ],
      },
      { text: '', toolCalls: [{ id: 'call-read', name: 'read_file', args: { path: 'README.md' } }] },
      { text: 'Unreached fallback.', toolCalls: [] },
    ]);
    const registry = new ToolRegistry();
    registerSubmitSolutionTool(registry, workspace);
    let readFileExecuted = false;
    registry.register({
      name: 'read_file',
      description: 'Read file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } as any,
      execute: async () => {
        readFileExecuted = true;
        return { content: '# readme' };
      },
    });
    const loop = new AgentLoop(llm as any, registry, { workspace, maxSteps: 6 });
    const session = new Session('session-submit-blocked');
    session.addUserMessage('Investigate why login crashes.');
    const result = await loop.run(session);
    assert.match(String(result), /authenticate reads session\.token/);
    assert.equal(llm.calls, 1, 'read-only submission finalizes without a redundant provider call');
    assert.equal(readFileExecuted, false, 'blocked read_file must never execute');
    const blocked = session
      .getEvents()
      .filter((e: any) => e.type === 'tool/result')
      .find((e: any) => e.data?.result?.errorCode === 'POST_SUBMISSION_TOOL_CALL_BLOCKED');
    assert.ok(blocked, 'expected a POST_SUBMISSION_TOOL_CALL_BLOCKED record');
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
  }
});
