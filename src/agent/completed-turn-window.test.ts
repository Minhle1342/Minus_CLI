import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ContextCompactor, type TurnWindowEntry } from './context-compactor.js';
import { Session } from '../session/session.js';
import { assertHistoryToolPairing } from '../session/session-invariants.js';
import { AgentLoop } from './agent-loop.js';
import { ToolRegistry } from '../tools/registry.js';
import { Workspace } from '../workspace/workspace.js';

function buildTurnSession(turns: number, options: { systemInterleaved?: boolean } = {}): Session {
  const session = new Session(`session-turn-window-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  for (let turn = 1; turn <= turns; turn++) {
    if (options.systemInterleaved) {
      session.addUserMessage(`[SYSTEM CONTEXT for turn ${turn}]`, 'system');
    }
    session.addUserMessage(`Turn ${turn} request`, 'human');
    session.append('turn/start', { turn });
    session.addModelMessage({ text: `Turn ${turn} result with Decided approach number ${turn}` });
    session.append('turn/end', { turn, reason: 'completed' });
  }
  return session;
}

function toEntries(session: Session): TurnWindowEntry[] {
  return session.getProjectionWithTurns().map((entry) => ({
    message: entry.message,
    turn: entry.turn,
    isSynopsis: entry.isSynopsis,
  }));
}

function countSynopses(messages: Array<{ parts?: any[] }>): number {
  const text = JSON.stringify(messages);
  return (text.match(/ROLLING DIALOGUE SYNOPSIS/g) || []).length;
}

describe('Completed-turn window compaction', () => {
  it('prunes the oldest turn once completed turns exceed 4', () => {
    const session = buildTurnSession(5);
    assert.deepEqual(session.getCompletedTurnNumbers(), [1, 2, 3, 4, 5]);
    assert.equal(session.getOpenTurn(), undefined);

    const compactor = new ContextCompactor({ preserveCompletedTurns: 4 });
    const result = compactor.compactCompletedTurnWindow(toEntries(session), {
      completedTurns: session.getCompletedTurnNumbers(),
      preserveCompletedTurns: 4,
    });

    assert.equal(result.stats.prunedTurnsCount, 1);
    assert.equal(result.stats.archivedTurns?.length, 1);
    assert.equal(result.stats.archivedTurns?.[0].turnNumber, 1);
    assert.match(JSON.stringify(result.messages), /TURN 1 ARCHIVED/);
    assert.match(JSON.stringify(result.messages), /Turn 5 request/);
    assert.equal(countSynopses(result.messages as any[]), 1);
    assertHistoryToolPairing(result.messages as any);
    assert.ok(result.stats.strategiesApplied.includes('completed-turn-window-compaction'));
  });

  it('is a no-op at exactly 4 completed turns', () => {
    const session = buildTurnSession(4);
    const compactor = new ContextCompactor({ preserveCompletedTurns: 4 });
    const before = toEntries(session).map((e) => e.message);
    const result = compactor.compactCompletedTurnWindow(toEntries(session), {
      completedTurns: session.getCompletedTurnNumbers(),
      preserveCompletedTurns: 4,
    });
    assert.equal(result.stats.prunedTurnsCount, 0);
    assert.equal(result.stats.archivedTurns?.length, 0);
    assert.deepEqual(result.messages, before);
  });

  it('does not count system/injected prompts as turns', () => {
    const session = buildTurnSession(5, { systemInterleaved: true });
    assert.deepEqual(session.getCompletedTurnNumbers(), [1, 2, 3, 4, 5]);

    const compactor = new ContextCompactor({ preserveCompletedTurns: 4 });
    const result = compactor.compactCompletedTurnWindow(toEntries(session), {
      completedTurns: session.getCompletedTurnNumbers(),
      preserveCompletedTurns: 4,
    });
    assert.equal(result.stats.prunedTurnsCount, 1);
    assert.equal(result.stats.archivedTurns?.[0].turnNumber, 1);
  });

  it('is idempotent: a second pass prunes nothing and keeps one synopsis', () => {
    const session = buildTurnSession(5);
    const compactor = new ContextCompactor({ preserveCompletedTurns: 4 });
    const first = compactor.compactCompletedTurnWindow(toEntries(session), {
      completedTurns: session.getCompletedTurnNumbers(),
      preserveCompletedTurns: 4,
    });
    session.setHistory(first.messages as any, 'completed-turn-window', {
      schemaVersion: 1,
      generation: 1,
      sourceFingerprint: 'test',
      archivedTurnIds: (first.stats.archivedTurns || []).map((t) => t.id),
      turnWindow: {
        preservedTurns: [2, 3, 4, 5],
        archivedTurnNumbers: [1],
        archivedTurnIds: (first.stats.archivedTurns || []).map((t) => t.id),
      },
    });

    const second = compactor.compactCompletedTurnWindow(toEntries(session), {
      completedTurns: session.getCompletedTurnNumbers(),
      preserveCompletedTurns: 4,
    });
    assert.equal(second.stats.prunedTurnsCount, 0);
    assert.equal(countSynopses(second.messages as any[]), 1);
    assert.match(JSON.stringify(second.messages), /Turn #1/);
  });

  it('never prunes the open turn', () => {
    const session = buildTurnSession(5);
    session.addUserMessage('Turn 6 request', 'human');
    session.append('turn/start', { turn: 6 });
    session.addModelMessage({ text: 'Turn 6 partial result' });
    assert.equal(session.getOpenTurn(), 6);
    assert.deepEqual(session.getCompletedTurnNumbers(), [1, 2, 3, 4, 5]);

    const compactor = new ContextCompactor({ preserveCompletedTurns: 4 });
    const result = compactor.compactCompletedTurnWindow(toEntries(session), {
      completedTurns: session.getCompletedTurnNumbers(),
      openTurn: session.getOpenTurn(),
      preserveCompletedTurns: 4,
    });
    assert.equal(result.stats.archivedTurns?.[0].turnNumber, 1);
    assert.match(JSON.stringify(result.messages), /Turn 6 partial result/);
    assert.match(JSON.stringify(result.messages), /Turn 5 request/);
  });

  it('keeps tool call/result pairs intact across the window', () => {
    const session = new Session(`session-turn-window-tools-${Date.now()}`);
    for (let turn = 1; turn <= 5; turn++) {
      session.addUserMessage(`Turn ${turn} request`, 'human');
      session.append('turn/start', { turn });
      if (turn === 1 || turn === 5) {
        const assistantSeq = session.seq + 1;
        session.addModelMessage({
          functionCalls: [{ name: 'read_file', args: { path: `file-${turn}.ts` }, id: `call-${turn}` } as any],
        });
        session.append('tool/call', {
          toolName: 'read_file',
          toolCallId: `call-${turn}`,
          assistantSeq,
          args: { path: `file-${turn}.ts` },
        });
        session.addToolResultWithId('read_file', { path: `file-${turn}.ts`, content: `content-${turn}` }, `call-${turn}`);
      } else {
        session.addModelMessage({ text: `Turn ${turn} result with Decided approach ${turn}` });
      }
      session.append('turn/end', { turn, reason: 'completed' });
    }

    const compactor = new ContextCompactor({ preserveCompletedTurns: 4 });
    const result = compactor.compactCompletedTurnWindow(toEntries(session), {
      completedTurns: session.getCompletedTurnNumbers(),
      preserveCompletedTurns: 4,
    });
    assertHistoryToolPairing(result.messages as any);
    assert.match(JSON.stringify(result.messages), /call-5/);
    assert.equal(result.stats.archivedTurns?.[0].turnNumber, 1);
    assert.ok((result.stats.archivedTurns?.[0].toolsUsed || []).includes('read_file'));
  });

  it('rejects a turn-window manifest that references the open turn', () => {
    const session = buildTurnSession(2);
    session.addUserMessage('Turn 3 request', 'human');
    session.append('turn/start', { turn: 3 });
    assert.throws(() => {
      session.setHistory(toEntries(session).map((e) => e.message) as any, 'completed-turn-window', {
        turnWindow: { preservedTurns: [2, 3], archivedTurnNumbers: [1], archivedTurnIds: [] },
      });
    }, /open turn 3/);
  });

  it('AgentLoop leaves five short turns intact without token pressure', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'turn-window-loop-'));
    try {
      class ScriptedLLM {
        async generate(): Promise<any> {
          return { text: 'Task done with Decided final approach.', toolCalls: [] };
        }
      }
      const workspace = new Workspace(rootDir);
      const loop = new AgentLoop(new ScriptedLLM() as any, new ToolRegistry(), { workspace, maxSteps: 4 });
      const session = new Session(`session-loop-window-${Date.now()}`);

      for (let i = 1; i <= 5; i++) {
        session.addUserMessage(`Loop task ${i}`);
        await loop.run(session);
      }

      assert.deepEqual(session.getCompletedTurnNumbers(), [1, 2, 3, 4, 5]);
      const compactions = session.getEvents().filter(
        (e) => e.type === 'session/compaction' && (e.data as any).reason === 'completed-turn-window',
      );
      assert.equal(compactions.length, 0);
      assert.doesNotMatch(JSON.stringify(session.getHistory()), /ROLLING DIALOGUE SYNOPSIS/);
      assert.equal(loop.turnMemoryRetriever.getArchivedTurnCount(), 0);
      session.assertRuntimeInvariants();
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
