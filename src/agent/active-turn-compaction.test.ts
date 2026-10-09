import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContextBudgetManager } from './context-budget-manager.js';
import { ContextCompactor } from './context-compactor.js';
import { Session } from '../session/session.js';
import { compactActiveTurnText } from './active-turn-compaction.js';
import { computeRequestValueDigest } from '../session/session-invariants.js';
import { AgentLoop } from './agent-loop.js';
import { ToolRegistry } from '../tools/registry.js';
import { Workspace } from '../workspace/workspace.js';
import { SessionPersistence } from '../session/session-persistence.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const brainstorming = 'Exploring another possible arrangement with repeated discussion.\n'.repeat(12000)
  + 'Decision: retain the existing parser API.\nConstraint: never delete user files.\nTODO: verify parser.test.ts.\nLatest direction: implement the adapter next.';

async function prepare(session: Session, maxInputTokens = 8000) {
  return new ContextBudgetManager(new ContextCompactor(), { mode: 'enforce' }).prepareRequest({
    provider: 'openai', model: 'gpt-6-sol', systemPrompt: 'agent', tools: [], history: session.getHistory(),
    maxInputTokens, outputReserveTokens: 1000,
  }, { protectActiveTurn: true, recoveryWindow: { entries: session.getProjectionWithTurns(),
    completedTurns: session.getCompletedTurnNumbers(), openTurn: session.getOpenTurn() } });
}

test('long active brainstorming is archived and reduced while current instructions and tool evidence stay intact', async () => {
  const session = new Session(); session.append('turn/start', { turn: 1 }); session.addUserMessage('Fix the parser; preserve its API.');
  session.addModelMessage({ text: brainstorming });
  session.addModelMessage({ functionCalls: [{ id: 'read', name: 'read_file', args: { path: 'parser.ts' } }] });
  session.addToolResultWithId('read_file', { content: 'original parser evidence', path: 'parser.ts' }, 'read');
  const original = session.getHistory();
  const result = await prepare(session);
  assert.equal(result.withinBudget, true);
  assert.equal(result.changed, true);
  assert.deepEqual(result.history[0], original[0]);
  assert.deepEqual(result.history.slice(-2), original.slice(-2));
  const text = JSON.stringify(result.history);
  assert.match(text, /retain the existing parser API/);
  assert.match(text, /never delete user files/);
  assert.match(text, /verify parser.test.ts/);
  assert.match(text, /implement the adapter next/);
  assert.ok(result.compactionStats?.maskedObservations?.some(record => record.originalPayload.content === brainstorming));
  session.setHistory(result.history, 'context-budget-enforce', result.state as any);
  const replay = Session.fromSnapshot(session.toSnapshot());
  assert.equal(replay.getOpenTurn(), 1);
  assert.equal(replay.getProjectionWithTurns().find(entry => entry.message.role === 'model')?.turn, 1);
  assert.ok(replay.getEvents().some(event => event.type === 'assistant/message'
    && event.data.content?.parts?.some(part => part.text === brainstorming)));
  const again = await prepare(replay);
  assert.deepEqual(again.history, result.history);
});

test('unattributed and cross-turn duplicate prose cannot authorize active compaction', () => {
  const message = { role: 'model', parts: [{ text: brainstorming }] };
  assert.equal(compactActiveTurnText([message], [{ message }], 2).replacements.length, 0);
  assert.equal(compactActiveTurnText([message], [{ message, turn: 1 }, { message, turn: 2 }], 2).replacements.length, 0);
});

test('unlabelled task state and decision reversals in the middle survive reduction verbatim', () => {
  const state = 'We will use the streaming adapter and preserve synchronous callbacks.\n'
    + 'The parser API stays backwards compatible.\nImplementation starts after the migration finishes.';
  const message = { role: 'model', parts: [{ text: brainstorming + '\n' + state
    + '\nUse A\nUse B\nUse A\n' + 'Exploring another arrangement.\n'.repeat(10000) }] };
  const result = compactActiveTurnText([message], [{ message, turn: 1 }], 1);
  const reduced = result.messages[0].parts?.[0].text || '';
  assert.equal(result.replacements.length, 1);
  assert.ok(reduced.includes(state));
  assert.ok(reduced.includes('Use A\nUse B\nUse A'));
});

test('repeated headings retain their original association with multiline requirements', () => {
  const requirements = 'Required:\nKeep the parser API.\nOptional:\nAdd metrics.\nRequired:\nKeep callbacks synchronous.';
  const message = { role: 'model', parts: [{ text: brainstorming + '\n' + requirements
    + '\n' + 'Exploring another arrangement.\n'.repeat(10000) }] };
  const result = compactActiveTurnText([message], [{ message, turn: 1 }], 1);
  assert.equal(result.replacements.length, 1);
  assert.ok(result.messages[0].parts?.[0].text?.includes(requirements));
});

test('long non-repetitive prose is preserved instead of dropping unknown task state', () => {
  const unique = Array.from({ length: 2000 }, (_, index) => `Different substantive statement ${index}: retain this information.`).join('\n');
  const message = { role: 'model', parts: [{ text: unique }] };
  assert.deepEqual(compactActiveTurnText([message], [{ message, turn: 1 }], 1).messages, [message]);
});

test('mixed assistant prose and pending function call preserve the exact call and provider metadata', () => {
  const message = { role: 'model', parts: [{ text: brainstorming },
    { functionCall: { id: 'pending', name: 'read_file', args: { path: 'a.ts' } } }] };
  const reduced = compactActiveTurnText([message], [{ message, turn: 1 }], 1);
  assert.equal(reduced.replacements.length, 1);
  assert.deepEqual(reduced.messages[0].parts?.[1], message.parts[1]);
});

test('replay rejects a draft mapping to a completed turn or absent original', () => {
  const session = new Session(); session.append('turn/start', { turn: 1 });
  session.addModelMessage({ text: brainstorming }); session.append('turn/end', { turn: 1, reason: 'completed' });
  session.append('turn/start', { turn: 2 }); session.addUserMessage('continue');
  const reduced = { role: 'model', parts: [{ text: 'draft summary' }] };
  for (const beforeDigest of [computeRequestValueDigest(session.getHistory()[0]), 'absent']) {
    const copy = Session.fromSnapshot(session.toSnapshot());
    copy.setHistory([reduced], 'context-budget-enforce', { activeTextReplacements: [{
      beforeDigest, afterDigest: computeRequestValueDigest(reduced), turn: 2,
    }] } as any);
    assert.equal(copy.getProjectionWithTurns()[0].turn, undefined);
  }
});

test('a partial active reduction still fails on the full calibrated upper bound', async () => {
  const session = new Session(); session.append('turn/start', { turn: 1 }); session.addUserMessage('Continue the task.');
  session.addModelMessage({ text: brainstorming });
  const manager = new ContextBudgetManager(new ContextCompactor(), { mode: 'enforce', counter: {
    async count(envelope) {
      const large = JSON.stringify(envelope.history).length > 100000;
      return { inputTokens: large ? 200000 : 6000, upperBoundTokens: large ? 210000 : 7500,
        historyTokens: large ? 199000 : 5000, nonHistoryTokens: 1000, source: 'calibrated', hardBound: false, errorMarginRatio: 0.25 };
    },
  } });
  const result = await manager.prepareRequest({ provider: 'openai', model: 'gpt-6-sol', systemPrompt: 'fixed overhead',
    tools: [], history: session.getHistory(), maxInputTokens: 8000, outputReserveTokens: 1000 }, {
    protectActiveTurn: true, recoveryWindow: { entries: session.getProjectionWithTurns(), completedTurns: [], openTurn: 1 },
  });
  assert.equal(result.changed, true);
  assert.equal(result.after.upperBoundTokens, 7500);
  assert.equal(result.failureReason, 'CONTEXT_BUDGET_UNSATISFIABLE');
  assert.equal(result.compactionStats?.withinBudget, false);
  assert.equal(result.compactionStats?.budgetOverflowTokens, 500);
});

for (const archiveFails of [false, true]) {
  test(`AgentLoop ${archiveFails ? 'keeps active originals and stops when draft archive fails' : 'persists active draft and continues inference in the same session'}`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-active-draft-'));
    const persistence = new SessionPersistence(root);
    const session = new Session(); session.addUserMessage('Read parser.ts and explain its API.');
    let original: ReturnType<Session['getHistory']> | undefined; let calls = 0; let compactionsBeforeFailure = 0;
    try {
      await fs.writeFile(path.join(root, 'parser.ts'), 'export const parser = () => true;');
      const loop = new AgentLoop({ modelName: 'gpt-6-sol', getTokenConfig: () => ({ maxInputTokens: 128000, maxOutputTokens: 1000 }),
        async generate(current: Session) {
          calls++;
          if (calls === 1) return { text: brainstorming,
            toolCalls: [{ id: 'read', name: 'read_file', args: { path: 'parser.ts' } }] };
          assert.equal(current.id, session.id);
          const durable = await persistence.load(session.id);
          assert.ok(durable?.getEvents().some(event => event.type === 'assistant/message'
            && event.data.content?.parts?.some(part => part.text === brainstorming)));
          assert.ok(durable?.getEvents().some(event => event.type === 'session/compaction'));
          assert.match(JSON.stringify(current.getHistory()), /ACTIVE ASSISTANT TEXT COMPACTED/);
          assert.ok(JSON.stringify(current.getHistory()).length < 100000);
          const archives = JSON.parse(await fs.readFile(path.join(root, '.codingagent/memory/masked_observations.json'), 'utf8'));
          assert.ok(archives.some((record: any) => record.toolName === 'assistant_draft'));
          return { text: 'Parser task continued.', toolCalls: [] };
        },
      }, new ToolRegistry(), { workspace: new Workspace(root), sessionPersistence: persistence, maxSteps: 2 });
      if (archiveFails) (loop.turnMemoryRetriever as any).archiveMaskedObservations = async (records: any[]) => {
        if (records.some(record => record.toolName === 'assistant_draft')) {
          original = session.getHistory();
          compactionsBeforeFailure = session.getEvents().filter(event => event.type === 'session/compaction').length;
          throw new Error('draft archive disk failed');
        }
        return { inserted: 0, updated: 0, skipped: 0, evicted: [] };
      };
      if (archiveFails) {
        await assert.rejects(loop.run(session, { maxSteps: 2 }), /draft archive disk failed/);
        assert.equal(calls, 1);
        assert.deepEqual(session.getHistory(), original);
        assert.equal(session.getEvents().filter(event => event.type === 'session/compaction').length, compactionsBeforeFailure);
      } else {
        await loop.run(session, { maxSteps: 2 });
        assert.equal(calls, 2);
      }
    } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
}

test('budget pressure cannot shorten user instructions or provider signed text', async () => {
  const session = new Session(); session.append('turn/start', { turn: 1 }); session.addUserMessage('current '.repeat(30000));
  session.addModelMessage({ rawContent: { role: 'model', parts: [{ text: brainstorming, thoughtSignature: 'signed' } as any] } });
  const original = session.getHistory();
  const result = await prepare(session);
  assert.equal(result.failureReason, 'CONTEXT_BUDGET_UNSATISFIABLE');
  assert.deepEqual(result.history, original);
});

test('code-bearing assistant messages remain unchanged', async () => {
  const session = new Session(); session.append('turn/start', { turn: 1 }); session.addUserMessage('Keep this code.');
  session.addModelMessage({ text: brainstorming + '\n```ts\nconst value = 1;\n```' });
  assert.deepEqual((await prepare(session)).history, session.getHistory());
});
