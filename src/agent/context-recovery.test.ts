import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContextBudgetManager } from './context-budget-manager.js';
import { ContextCompactor } from './context-compactor.js';
import { Session } from '../session/session.js';
import { AgentLoop } from './agent-loop.js';
import { ToolRegistry } from '../tools/registry.js';
import { Workspace } from '../workspace/workspace.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionPersistence } from '../session/session-persistence.js';

test('recovery summarizes completed turns while preserving the open turn and task state', async () => {
  const session = new Session();
  session.append('turn/start', { turn: 1 }); session.addUserMessage('Implement feature alpha');
  session.addModelMessage({ text: 'old details '.repeat(20000) }); session.append('turn/end', { turn: 1, reason: 'completed' });
  session.setHistory(session.getHistory(), 'previous-compaction');
  session.append('turn/start', { turn: 2 }); session.addUserMessage('Keep the current request intact');
  session.addModelMessage({ functionCalls: [{ id: 'pending', name: 'read_file', args: { path: 'a.ts' } }] });
  session.addToolResultWithId('read_file', { path: 'a.ts', content: 'current evidence' }, 'pending');
  const history = session.getHistory();
  const active = session.getProjectionWithTurns().filter(e => e.turn === session.getOpenTurn()).map(e => e.message);
  const manager = new ContextBudgetManager(new ContextCompactor(), { mode: 'enforce' });
  const options: any = { protectActiveTurn: true, protectedMessages: active,
    recoveryWindow: { entries: session.getProjectionWithTurns(), completedTurns: session.getCompletedTurnNumbers(), openTurn: session.getOpenTurn() },
    plan: { nodes: [{ id: 1, title: 'Finish alpha', status: 'in_progress', dependencies: [] }], readyTaskIds: [], blocked: [] },
  };
  const result = await manager.prepareRequest({ provider: 'openai', model: 'gpt-6-sol', systemPrompt: 'agent', tools: [], history, maxInputTokens: 8000, outputReserveTokens: 1000 }, options);
  assert.equal(result.failureReason, undefined);
  assert.equal(result.withinBudget, true);
  assert.equal(result.changed, true);
  assert.deepEqual(result.history.slice(-active.length), active);
  assert.equal(result.compactionStats?.archivedTurns?.length, 1);
  assert.match(JSON.stringify(result.history), /Finish alpha/);
  assert.match(JSON.stringify(result.compactionStats?.archivedTurns), /old details/);
  assert.equal(session.getOpenTurn(), 2, 'preparation must not end or replace the session');
  session.setHistory(result.history, 'context-budget-enforce', result.state as any);
  const replay = Session.fromSnapshot(session.toSnapshot());
  assert.deepEqual(replay.getProjectionWithTurns().filter(e => e.turn === 2).map(e => e.message), active);
  assert.equal(replay.id, session.id);
});

test('recovery reports failure when the current request alone exceeds the budget', async () => {
  const session = new Session(); session.append('turn/start', { turn: 1 }); session.addUserMessage('current '.repeat(30000));
  const history = session.getHistory();
  const result = await new ContextBudgetManager(new ContextCompactor(), { mode: 'enforce' }).prepareRequest({ provider: 'openai', model: 'gpt-6-sol', systemPrompt: 'agent', tools: [], history, maxInputTokens: 8000, outputReserveTokens: 1000 }, {
    protectActiveTurn: true, recoveryWindow: { entries: session.getProjectionWithTurns(), completedTurns: [], openTurn: session.getOpenTurn() },
  } as any);
  assert.equal(result.failureReason, 'CONTEXT_BUDGET_UNSATISFIABLE');
  assert.deepEqual(result.history, history);
});

test('replay never assigns a retained duplicate current prompt to an archived older turn', () => {
  const session = new Session();
  session.append('turn/start', { turn: 1 }); session.addUserMessage('continue');
  session.addModelMessage({ text: 'older evidence' }); session.append('turn/end', { turn: 1, reason: 'completed' });
  session.append('turn/start', { turn: 2 }); session.addUserMessage('continue');
  session.addModelMessage({ text: 'current evidence' });
  session.setHistory(session.getHistory().slice(-2), 'older-compaction');
  const entries = Session.fromSnapshot(session.toSnapshot()).getProjectionWithTurns();
  const compacted = new ContextCompactor().compactCompletedTurnWindow(entries, { completedTurns: [1], openTurn: 2, preserveCompletedTurns: 0 });
  assert.deepEqual(compacted.messages, session.getHistory());
  assert.equal(compacted.stats.archivedTurns?.length, 0);
});

test('recovery also handles a completed user-only turn followed by the current prompt', async () => {
  const session = new Session(); session.append('turn/start', { turn: 1 });
  session.addUserMessage('old user details '.repeat(15000)); session.append('turn/end', { turn: 1, reason: 'cancelled' });
  session.append('turn/start', { turn: 2 }); session.addUserMessage('hi');
  const result = await new ContextBudgetManager(new ContextCompactor(), { mode: 'enforce' }).prepareRequest({ provider: 'openai', model: 'gpt-6-sol', systemPrompt: 'agent', tools: [], history: session.getHistory(), maxInputTokens: 8000, outputReserveTokens: 1000 }, {
    protectActiveTurn: true, recoveryWindow: { entries: session.getProjectionWithTurns(), completedTurns: [1], openTurn: 2 },
  });
  assert.equal(result.withinBudget, true);
  assert.equal(result.compactionStats?.archivedTurns?.length, 1);
  assert.equal(result.history.at(-1)?.parts?.[0]?.text, 'hi');
});

for (const archiveFails of [false, true]) {
  test(`AgentLoop ${archiveFails ? 'preserves history on archive failure' : 'archives recovery before inference in the same session'}`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-recovery-'));
    const persistence = new SessionPersistence(root);
    const session = new Session();
    session.addUserMessage('Explain alpha'); session.append('turn/start', { turn: 1 });
    session.addModelMessage({ text: 'original source evidence '.repeat(60000) });
    session.append('turn/end', { turn: 1, reason: 'completed' });
    session.setHistory(session.getHistory(), 'earlier-compaction');
    session.addUserMessage('Explain in one sentence');
    const original = session.getHistory();
    let calls = 0;
    const llm = { modelName: 'gpt-6-sol', getTokenConfig: () => ({ maxInputTokens: 128000, maxOutputTokens: 1000 }),
      async generate(current: Session) {
        calls++;
        assert.equal(current.id, session.id);
        const durable = await persistence.load(session.id);
        assert.ok(durable?.getEvents().some(e => e.type === 'session/compaction' && e.data.reason !== 'earlier-compaction'));
        assert.match(JSON.stringify(current.getHistory()), /Explain in one sentence/);
        assert.ok(JSON.stringify(current.getHistory()).length < 100000);
        return { text: 'Alpha is a feature.', toolCalls: [], finishReason: 'stop' };
      },
    };
    try {
      const loop = new AgentLoop(llm, new ToolRegistry(), { workspace: new Workspace(root), sessionPersistence: persistence, contextManagementMode: 'auto', maxSteps: 1 });
      if (archiveFails) (loop as any).turnMemoryRetriever.archiveTurns = async () => { throw new Error('archive disk failed'); };
      if (archiveFails) {
        await assert.rejects(loop.run(session, { maxSteps: 1 }), /archive disk failed/);
        assert.equal(calls, 0);
        assert.deepEqual(session.getHistory(), original);
      } else {
        await loop.run(session, { maxSteps: 1 });
        assert.equal(calls, 1);
        const compaction = session.getEvents().find(e => e.type === 'session/compaction' && e.data.reason !== 'earlier-compaction');
        assert.ok((compaction?.data.compactionState as any)?.archiveStatus?.archivedTurns);
        assert.ok(session.getEvents().some(e => e.type === 'assistant/message' && JSON.stringify(e).includes('original source evidence')));
      }
    } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
}

test('AgentLoop displays the unrecoverable budget error and never calls inference', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-recovery-error-'));
  const session = new Session(); session.addUserMessage('active request '.repeat(60000));
  const errors: string[] = []; const originalError = console.error;
  let calls = 0;
  try {
    console.error = (...values) => errors.push(values.join(' '));
    const loop = new AgentLoop({ modelName: 'gpt-6-sol', getTokenConfig: () => ({ maxInputTokens: 128000, maxOutputTokens: 1000 }), async generate() { calls++; throw new Error('must not call'); } }, new ToolRegistry(), { workspace: new Workspace(root), maxSteps: 1 });
    const result = await loop.run(session, { maxSteps: 1 });
    assert.match(result, /CONTEXT_BUDGET_UNSATISFIABLE/);
    assert.match(errors.join('\n'), /CONTEXT_BUDGET_UNSATISFIABLE.*\d+\/127000/);
    assert.match(errors.join('\n'), /\/context status/);
    assert.equal(calls, 0);
    assert.ok(session.getHistory().some(m => m.parts?.some(p => p.text?.endsWith('active request '.repeat(60000)))));
  } finally { console.error = originalError; await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('AgentLoop stops after partial recovery when the upper bound still exceeds the reserved input budget', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-recovery-bound-'));
  const session = new Session(); session.addUserMessage('old task'); session.append('turn/start', { turn: 1 });
  session.addModelMessage({ text: 'old evidence '.repeat(60000) }); session.append('turn/end', { turn: 1, reason: 'completed' });
  session.addUserMessage('Explain the result'); let calls = 0;
  try {
    const loop = new AgentLoop({ modelName: 'gpt-6-sol', getTokenConfig: () => ({ maxInputTokens: 128000, maxOutputTokens: 1000 }), async generate() { calls++; return { text: 'reply', toolCalls: [] }; } }, new ToolRegistry(), { workspace: new Workspace(root), maxSteps: 1 });
    // Model a calibrated upper bound above the limit despite a lower point estimate.
    (loop.contextBudgetManager as any).counter = { async count(envelope: any) {
      const large = JSON.stringify(envelope.history).length > 100000;
      return { inputTokens: large ? 200000 : 124000, upperBoundTokens: large ? 210000 : 130200,
        historyTokens: large ? 199000 : 123000, nonHistoryTokens: 1000, source: 'calibrated', hardBound: false, errorMarginRatio: 0.05 };
    } };
    const result = await loop.run(session, { maxSteps: 1 });
    assert.match(result, /CONTEXT_BUDGET_UNSATISFIABLE/);
    assert.equal(calls, 0);
    assert.ok(session.getEvents().some(e => e.type === 'session/compaction'), 'partial recovery must have occurred');
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
