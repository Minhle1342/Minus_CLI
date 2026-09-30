import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractRequestAnalysis, AgentLoop } from './agent-loop.js';
import { CORE_SYSTEM_PROMPT } from '../llm/prompt-sections.js';
import { ContextCompactor } from './context-compactor.js';
import { CLI } from '../ui/cli-ui.js';
import { ToolRegistry } from '../tools/registry.js';
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

test('CORE_SYSTEM_PROMPT instructs a [REQUEST ANALYSIS] block before the first tool call', () => {
  assert.match(CORE_SYSTEM_PROMPT, /\[REQUEST ANALYSIS\]/);
  assert.match(CORE_SYSTEM_PROMPT, /goal, scope, ambiguities/);
});

test('CORE_SYSTEM_PROMPT stays within the lean token budget after the new line', () => {
  const tokens = ContextCompactor.estimateTokens(CORE_SYSTEM_PROMPT);
  assert.ok(tokens < 1500, `expected < 1500 tokens, got ~${tokens}`);
  assert.ok(!CORE_SYSTEM_PROMPT.includes('5-STAGE ERROR DETECTIVE'));
  assert.ok(CORE_SYSTEM_PROMPT.includes('VERIFICATION LADDER'));
  assert.ok(CORE_SYSTEM_PROMPT.includes('FINAL ANSWER LANGUAGE MATCHING'));
  assert.ok(CORE_SYSTEM_PROMPT.includes('custom build command'));
});

test('extractRequestAnalysis pulls the block with or without a close tag', () => {
  const withClose = extractRequestAnalysis(
    '[REQUEST ANALYSIS]\nGoal: fix login.\nScope: src/auth.\n[/REQUEST ANALYSIS]\nThen I will read the file.',
  );
  assert.equal(withClose, 'Goal: fix login.\nScope: src/auth.');

  const noClose = extractRequestAnalysis('[request analysis]\nGoal: fix login.\nScope: src/auth.');
  assert.equal(noClose, 'Goal: fix login.\nScope: src/auth.');

  assert.equal(extractRequestAnalysis('Just thinking without a marker.'), undefined);
  assert.equal(extractRequestAnalysis('[REQUEST ANALYSIS]   \n  '), undefined);
  assert.equal(extractRequestAnalysis(undefined), undefined);
  assert.equal(extractRequestAnalysis(''), undefined);
});

test('CLI.renderRequestAnalysis prints the full block with a header', () => {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...args: any[]) => {
    output.push(args.map(String).join(' '));
  };
  try {
    CLI.renderRequestAnalysis('Goal: fix login.\nScope: src/auth.\nAmbiguity: which provider?');
  } finally {
    console.log = originalLog;
  }
  const rendered = output.join('\n');
  assert.match(rendered, /Request Analysis/);
  assert.match(rendered, /Goal: fix login/);
  assert.match(rendered, /Ambiguity: which provider/);
});

test('Loop displays the [REQUEST ANALYSIS] block fully on TUI', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'req-analysis-'));
  try {
    const workspace = new Workspace(rootDir);
    const llm = new ScriptedCompletionLLM([
      {
        reasoningContent: '[REQUEST ANALYSIS]\nGoal: read sample.\nScope: sample.txt.\n[/REQUEST ANALYSIS]\nNow reading the file.',
        text: '',
        toolCalls: [{ id: 'call-read', name: 'read_file', args: { path: 'sample.txt' } }],
      },
      { text: 'Done reading.', toolCalls: [] },
    ]);
    const registry = new ToolRegistry();
    registry.register({
      name: 'read_file',
      description: 'Read file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } as any,
      execute: async () => ({ content: 'hello' }),
    });
    const loop = new AgentLoop(llm as any, registry, { workspace, maxSteps: 4 });
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: any[]) => {
      output.push(args.map(String).join(' '));
    };
    try {
      const session = new Session('session-req-analysis');
      session.addUserMessage('Read the sample file.');
      await loop.run(session);
    } finally {
      console.log = originalLog;
    }
    const rendered = output.join('\n');
    assert.match(rendered, /Request Analysis/);
    assert.match(rendered, /Goal: read sample/);
    assert.match(rendered, /Scope: sample\.txt/);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
  }
});
