import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractHypothesisFromReasoning, isTestFailureRelatedToCurrentTurn, AgentLoop } from './agent-loop.js';
import { FinalAnswerGuard } from './final-answer-guard.js';
import { HypothesisTracker } from './hypothesis-tracker.js';
import { ToolRegistry } from '../tools/registry.js';
import { Session } from '../session/session.js';
import { Workspace } from '../workspace/workspace.js';

test('extractHypothesisFromReasoning extracts hypothesis and falsification test correctly', () => {
  const reasoning1 = `
Some analysis here...
[HYPOTHESIS] The null pointer is caused by undefined options in render()
[FALSIFICATION] npm test -- -t "render with empty options"
Next steps...
`;
  const res1 = extractHypothesisFromReasoning(reasoning1);
  assert.ok(res1);
  assert.equal(res1.statement, 'The null pointer is caused by undefined options in render()');
  assert.equal(res1.falsificationTest, 'npm test -- -t "render with empty options"');

  const reasoning2 = `
Hypothesis: Fix caching bug in memory-store.ts
Falsification: node --test test/cache.test.js
`;
  const res2 = extractHypothesisFromReasoning(reasoning2);
  assert.ok(res2);
  assert.equal(res2.statement, 'Fix caching bug in memory-store.ts');
  assert.equal(res2.falsificationTest, 'node --test test/cache.test.js');

  const reasoningNoHypothesis = 'Just exploring the files to understand architecture.';
  assert.equal(extractHypothesisFromReasoning(reasoningNoHypothesis), undefined);
  assert.equal(extractHypothesisFromReasoning(undefined), undefined);
});

test('isTestFailureRelatedToCurrentTurn classifies failures accurately', () => {
  const modified = new Set(['src/agent/agent-loop.ts']);

  // Case 1: Empty modified files -> unrelated (false)
  assert.equal(
    isTestFailureRelatedToCurrentTurn(new Set(), { stderr: 'Error in agent-loop.ts' }),
    false,
  );

  // Case 2: Output mentions modified file -> related (true)
  assert.equal(
    isTestFailureRelatedToCurrentTurn(modified, {
      stdout: 'FAIL src/agent/agent-loop.ts:42:15 - syntax error',
      exitCode: 1,
    }),
    true,
  );

  // Case 3: Output mentions unrelated file -> unrelated (false)
  assert.equal(
    isTestFailureRelatedToCurrentTurn(modified, {
      stdout: 'FAIL test/unrelated-module.test.ts:10 - expected 1 to be 2',
      stderr: 'Error: Assert failed in test/unrelated-module.test.ts',
      exitCode: 1,
    }),
    false,
  );

  // Case 4: regressionEvidence explicit flags
  assert.equal(
    isTestFailureRelatedToCurrentTurn(
      modified,
      { stdout: 'Some error' },
      { classification: 'pre_existing_out_of_scope' },
    ),
    false,
  );

  assert.equal(
    isTestFailureRelatedToCurrentTurn(
      modified,
      { stdout: 'Some error' },
      { classification: 'new_failures_detected' },
    ),
    true,
  );
});

test('FinalAnswerGuard requires disclosing unrelated test failure before completing', () => {
  const guard = new FinalAnswerGuard();
  assert.equal(guard.getUnrelatedTestFailure(), undefined);

  // Normal answer passes
  const initialDecision = guard.evaluate('Task completed successfully.');
  assert.equal(initialDecision.allow, true);

  // Record an unrelated failure
  guard.recordUnrelatedTestFailure({
    command: 'npm test',
    notice: 'Unrelated failure in test/legacy.test.ts',
  });
  assert.ok(guard.getUnrelatedTestFailure());

  // Answer without mentioning unrelated failure is rejected
  const rejectedDecision = guard.evaluate('I fixed the bug in agent-loop.ts. Everything is complete!');
  assert.equal(rejectedDecision.allow, false);
  assert.equal(rejectedDecision.reason, 'unrelated-test-failure-not-disclosed');
  assert.ok(rejectedDecision.continuationPrompt?.includes('failed during this turn, but the failure was unrelated'));

  // Answer mentioning unrelated failure passes
  const allowedDecision = guard.evaluate(
    'I updated agent-loop.ts cleanly. Note: npm test had an unrelated test failure in legacy.test.ts that was pre-existing.',
  );
  assert.equal(allowedDecision.allow, true);

  // Reset clears the requirement
  guard.reset();
  assert.equal(guard.getUnrelatedTestFailure(), undefined);
  assert.equal(guard.evaluate('All finished.').allow, true);
});

test('HypothesisTracker manages lifecycle state transitions', () => {
  const tracker = new HypothesisTracker();
  const h = tracker.formulate({
    statement: 'Refactor test suite',
    falsificationTest: 'npm test',
    targetFiles: ['src/agent/agent-loop.ts'],
  });

  assert.equal(h.status, 'formulated');
  assert.equal(tracker.getActiveHypothesis()?.id, h.id);

  tracker.markTesting(h.id);
  assert.equal(tracker.getActiveHypothesis()?.status, 'testing');

  tracker.markValidated(h.id, 'Tests passed cleanly');
  assert.equal(tracker.getActiveHypothesis(), undefined);
  assert.equal(tracker.getValidatedHypotheses().length, 1);
});

class MockHypothesisLLM {
  modelName = 'mock-hypothesis-llm';
  callCount = 0;
  constructor(private readonly replies: any[]) {}
  getTokenConfig() {
    return { maxInputTokens: 32_000, maxOutputTokens: 2_000 };
  }
  async generate() {
    const reply = this.replies[this.callCount++];
    return reply || { text: 'Done', toolCalls: [] };
  }
}

test('AgentLoop does NOT rollback on unrelated test failure and enforces disclosure in final answer', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'unrelated-fail-test-'));
  try {
    const workspace = new Workspace(rootDir);
    await fs.mkdir(path.join(rootDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(rootDir, 'src', 'feature.ts'), 'export const val = 1;');

    const registry = new ToolRegistry();
    let fileModified = false;
    registry.register({
      name: 'write_file',
      description: 'write_file fixture',
      parameters: { type: 'OBJECT', properties: {} } as any,
      execute: async (args: any) => {
        fileModified = true;
        await fs.writeFile(path.join(rootDir, 'src', 'feature.ts'), args.content || 'export const val = 2;');
        return { success: true };
      },
    });

    registry.register({
      name: 'run_command',
      description: 'run_command fixture',
      parameters: { type: 'OBJECT', properties: {} } as any,
      execute: async () => {
        // Fails on completely unrelated file
        return {
          exitCode: 1,
          stdout: 'FAIL test/legacy-module.test.ts:4\nAssertionError: expected true but got false in legacy module',
        };
      },
    });

    const replies = [
      // Step 1: LLM reasoning includes hypothesis and calls write_file
      {
        reasoningContent: '[HYPOTHESIS] Updating val to 2 satisfies feature requirements\n[FALSIFICATION] npm test',
        toolCalls: [{ id: 'call-1', name: 'write_file', args: { path: 'src/feature.ts', content: 'export const val = 2;' } }],
      },
      // Step 2: LLM runs verification test (which fails unrelatedly)
      {
        toolCalls: [{ id: 'call-2', name: 'run_command', args: { command: 'npm test' } }],
      },
      // Step 3: LLM tries to complete WITHOUT mentioning the unrelated failure (should be rejected by guard)
      {
        text: 'I have updated feature.ts to val = 2. Everything is done.',
        toolCalls: [],
      },
      // Step 4: After rejection, LLM provides answer disclosing the unrelated test failure
      {
        text: 'I have updated src/feature.ts. Note: npm test had an unrelated test failure in legacy-module.test.ts.',
        toolCalls: [],
      },
    ];

    const llm = new MockHypothesisLLM(replies);

    const loop = new AgentLoop(llm as any, registry, {
      workspace,
      maxSteps: 10,
      toolControlMode: 'off',
      stepPromptGatingMode: 'off',
      enableDynamicToolRetrieval: false,
      enableStepSummarization: false,
      enableGraphRepositoryMap: false,
      enableRepositoryMemory: false,
      enableDynamicContextCache: false,
    });

    const session = new Session('unrelated-failure-session');
    session.addUserMessage('Update feature.ts');
    const finalAnswer = await loop.run(session);

    // Verify 4 calls were made (meaning Step 3 was rejected and Step 4 was accepted)
    assert.equal(llm.callCount, 4);
    assert.match(finalAnswer, /unrelated test failure/i);
    // Verify file changes were NOT rolled back
    const fileContent = await fs.readFile(path.join(rootDir, 'src', 'feature.ts'), 'utf-8');
    assert.equal(fileContent, 'export const val = 2;');
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
  }
});
