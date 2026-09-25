import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TurnMemoryRetriever, scoreVectorBatch } from './turn-memory-retriever.js';

test('scoreVectorBatch uses one native batch call and preserves candidate ordering', () => {
  let batchCalls = 0;
  let scalarCalls = 0;
  const result = scoreVectorBatch({
    rsBatchCosineSimilarity: (query, database, dims) => {
      batchCalls++;
      assert.deepEqual(Array.from(query), [1, 0]);
      assert.deepEqual(Array.from(database), [1, 0, 0, 1]);
      assert.equal(dims, 2);
      return [0.8, 0.2];
    },
    rsCosineSimilarity: () => {
      scalarCalls++;
      return 0;
    },
  }, [1, 0], [['first', [1, 0]], ['second', [0, 1]], ['invalid', [1]]]);

  assert.equal(batchCalls, 1);
  assert.equal(scalarCalls, 0);
  assert.deepEqual(Array.from(result.entries()), [['first', 0.8], ['second', 0.2]]);
});

test('scoreVectorBatch falls back to scalar cosine when batch scoring is unavailable', () => {
  const result = scoreVectorBatch({
    rsCosineSimilarity: (_query, vector) => vector[0],
  }, [1, 0], [['first', [0.4, 0]], ['second', [-1, 0]]]);

  assert.deepEqual(Array.from(result.entries()), [['first', 0.4], ['second', 0]]);
});

test('archived turns, episodic and semantic stores respect their caps', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-memory-caps-'));
  try {
    const retriever = new TurnMemoryRetriever(root);
    const turns = Array.from({ length: 205 }, (_, i) => ({
      id: `t-${i}`, turnNumber: i, userPrompt: `prompt ${i}`, assistantSummary: `done ${i}`,
      toolsUsed: [], filesTouched: [], keyDecisions: [],
      timestamp: new Date().toISOString(), vector: [i / 1000],
    }));
    await retriever.archiveTurns(turns);
    assert.equal(retriever.getArchivedTurnCount(), 200);
    const onDisk = JSON.parse(await fs.readFile(
      path.join(root, '.codingagent', 'memory', 'archived_turns.json'), 'utf8'));
    assert.equal(onDisk.length, 200);
    const missing = await retriever.retrieveRelevantTurns('prompt 0', { topK: 5, minScore: 0 });
    assert.equal(missing.some((hit) => hit.turn.id === 't-0'), false);
    const found = await retriever.retrieveRelevantTurns('prompt 204', { topK: 5, minScore: 0 });
    assert.ok(found.some((hit) => hit.turn.id === 't-204'));

    for (let i = 0; i < 102; i++) {
      await retriever.recordEpisodicExperience({
        id: `ep-${i}`, taskIntent: `intent ${i}`, faultLocalizedEntities: [],
        patchSummary: `patch ${i}`, verificationCommand: 'npm test', verificationExitCode: 0,
      });
    }
    assert.equal(retriever.getEpisodicExperienceCount(), 100);

    for (let i = 0; i < 102; i++) {
      await retriever.recordSemanticInvariant({
        id: `sem-${i}`, ruleStatement: `rule ${i} about modules`,
        category: 'coding_convention', applicablePatterns: [`pattern${i}`], confidence: 0.8,
      });
    }
    assert.equal(retriever.getSemanticInvariantCount(), 100);
    const sem = await retriever.retrieveDualMemory('rule 101 about modules', { topK: 5, minScore: 0 });
    assert.ok(sem.semanticInvariants.some((item) => item.record.id === 'sem-101'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('retrieveContextSnippet memoizes identical queries and invalidates on write', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-snippet-memo-'));
  try {
    const retriever = new TurnMemoryRetriever(root);
    await retriever.archiveTurns([{
      id: 't-1', turnNumber: 1, userPrompt: 'uniquery testalpha first',
      assistantSummary: 'first done', toolsUsed: [], filesTouched: [],
      keyDecisions: [], timestamp: new Date().toISOString(), vector: [0.5],
    }]);
    const first = await retriever.retrieveContextSnippet('uniquery testalpha', { minScore: 0 });
    const second = await retriever.retrieveContextSnippet('uniquery testalpha', { minScore: 0 });
    assert.equal(first, second);
    assert.deepEqual(retriever.getSnippetCacheStats(), { hits: 1, misses: 1 });
    await retriever.archiveTurns([{
      id: 't-2', turnNumber: 2, userPrompt: 'uniquery testalpha second marker',
      assistantSummary: 'second done', toolsUsed: [], filesTouched: [],
      keyDecisions: [], timestamp: new Date().toISOString(), vector: [0.5],
    }]);
    const third = await retriever.retrieveContextSnippet('uniquery testalpha', { minScore: 0 });
    assert.match(third, /second marker/);
    assert.notEqual(third, first);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('concurrent init and archiveTurns never lose pre-existing disk state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-init-race-'));
  try {
    const memDir = path.join(root, '.codingagent', 'memory');
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(
      path.join(memDir, 'archived_turns.json'),
      JSON.stringify([{
        id: 'turn-old', turnNumber: 1, userPrompt: 'old task prompt',
        assistantSummary: 'old done', toolsUsed: [], filesTouched: [],
        keyDecisions: [], timestamp: new Date().toISOString(),
      }]),
    );

    const retriever = new TurnMemoryRetriever(root);
    const loading = retriever.init();
    await retriever.archiveTurns([{
      id: 'turn-new', turnNumber: 2, userPrompt: 'new task prompt',
      assistantSummary: 'new done', toolsUsed: [], filesTouched: [],
      keyDecisions: [], timestamp: new Date().toISOString(),
    }]);
    await loading;

    const onDisk = JSON.parse(await fs.readFile(path.join(memDir, 'archived_turns.json'), 'utf8'));
    const diskIds = new Set(onDisk.map((doc: { id: string }) => doc.id));
    assert.ok(diskIds.has('turn-old'), 'pre-existing archive must survive a concurrent archive');
    assert.ok(diskIds.has('turn-new'), 'new archive must be persisted');
    assert.equal(retriever.getArchivedTurnCount(), 2);
    assert.ok((await retriever.retrieveRelevantTurns('old task prompt', { topK: 5, minScore: 0 }))
      .some((hit) => hit.turn.id === 'turn-old'), 'pre-existing archive must stay searchable');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
