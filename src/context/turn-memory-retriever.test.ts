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

test('memory stores are replaced atomically without leaving temp files behind', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-atomic-stores-'));
  try {
    const retriever = new TurnMemoryRetriever(root);
    await retriever.archiveTurns([{
      id: 't-atomic', turnNumber: 1, userPrompt: 'atomic write prompt',
      assistantSummary: 'atomic done', toolsUsed: [], filesTouched: [],
      keyDecisions: [], timestamp: new Date().toISOString(), vector: [0.5],
    }]);
    await retriever.recordEpisodicExperience({
      id: 'ep-atomic', taskIntent: 'atomic intent', faultLocalizedEntities: [],
      patchSummary: 'atomic patch', verificationCommand: 'npm test', verificationExitCode: 0,
    });
    await retriever.recordSemanticInvariant({
      id: 'sem-atomic', ruleStatement: 'atomic rule', category: 'architecture_invariant',
      applicablePatterns: [], confidence: 0.8,
    });
    await retriever.recordAntiPattern({
      id: 'ap-atomic', triggerPattern: 'atomic trigger', failedApproach: 'repeated unverified edit',
      negativeConstraint: 'verify first', taskClass: 'implement', timestamp: new Date().toISOString(),
    });

    const memDir = path.join(root, '.codingagent', 'memory');
    const entries = await fs.readdir(memDir);
    assert.deepEqual(entries.filter((name) => name.endsWith('.tmp')), [],
      'atomic replace must not leave temporary snapshots behind');
    for (const name of ['archived_turns.json', 'episodic_experiences.json', 'semantic_invariants.json', 'anti_patterns.json']) {
      const parsed = JSON.parse(await fs.readFile(path.join(memDir, name), 'utf8'));
      assert.ok(Array.isArray(parsed) && parsed.length > 0, `${name} must stay complete JSON`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('snippet memo is a bounded LRU keyed by memory version', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-snippet-lru-'));
  try {
    const retriever = new TurnMemoryRetriever(root);
    await retriever.archiveTurns([{
      id: 't-lru', turnNumber: 1, userPrompt: 'lru seed prompt', assistantSummary: 'seed',
      toolsUsed: [], filesTouched: [], keyDecisions: [], timestamp: new Date().toISOString(), vector: [0.5],
    }]);
    const memo = (retriever as any).snippetMemo as Map<string, string>;

    const query = (index: number) => `lru q${String(index).padStart(2, '0')}`;
    for (let index = 0; index < 32; index++) {
      await retriever.retrieveContextSnippet(query(index), { topK: 1 });
    }
    assert.equal(memo.size, 32, 'memo must stay at its cap');
    assert.deepEqual(retriever.getSnippetCacheStats(), { hits: 0, misses: 32 });

    // Chạm lại entry cũ nhất → nó thành most-recently-used.
    await retriever.retrieveContextSnippet(query(0), { topK: 1 });
    assert.deepEqual(retriever.getSnippetCacheStats(), { hits: 1, misses: 32 });

    // Thêm key mới: LRU đẩy q01 ra, giữ lại q00 vừa được chạm.
    await retriever.retrieveContextSnippet(query(33), { topK: 1 });
    assert.equal(memo.size, 32);
    const keys = Array.from(memo.keys());
    assert.ok(keys.some((key) => key.includes(query(0))), 'touched entry must survive eviction');
    assert.equal(keys.some((key) => key.includes(query(1))), false, 'least recently used entry must be evicted');

    // Ghi memory bump version: key cũ vẫn nằm trong LRU nhưng không thể trúng nữa,
    // và KHÔNG bị clear hàng loạt.
    const sizeBeforeWrite = memo.size;
    await retriever.archiveTurns([{
      id: 't-lru-2', turnNumber: 2, userPrompt: 'lru second prompt', assistantSummary: 'second',
      toolsUsed: [], filesTouched: [], keyDecisions: [], timestamp: new Date().toISOString(), vector: [0.5],
    }]);
    assert.equal(memo.size, sizeBeforeWrite, 'write must not wipe the memo wholesale');

    const missesBefore = retriever.getSnippetCacheStats().misses;
    await retriever.retrieveContextSnippet(query(33), { topK: 1 });
    assert.equal(
      retriever.getSnippetCacheStats().misses,
      missesBefore + 1,
      'version bump must force recompute instead of serving a stale snippet',
    );
    assert.ok(memo.size <= 32, 'memo remains bounded after the version bump');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('semantic memo reuses a snippet for a near-duplicate query', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-semantic-memo-'));
  try {
    const embed = (text: string): number[] => {
      if (text === 'alpha beta') return [1, 0];
      if (text === 'alpha beta!') return [0.995, 0.005];
      return [0, 1];
    };
    const retriever = new TurnMemoryRetriever(root, { embedQuery: embed });
    await retriever.archiveTurns([{
      id: 't-sem', turnNumber: 1, userPrompt: 'alpha beta memory', assistantSummary: 'done',
      toolsUsed: [], filesTouched: [], keyDecisions: [], timestamp: new Date().toISOString(), vector: [0.5],
    }]);

    const first = await retriever.retrieveContextSnippet('alpha beta', { topK: 1 });
    const missesAfterFirst = retriever.getSnippetCacheStats().misses;
    assert.equal(missesAfterFirst, 1);

    const nearDuplicate = await retriever.retrieveContextSnippet('alpha beta!', { topK: 1 });
    assert.equal(nearDuplicate, first, 'near-duplicate query must reuse the cached snippet');
    assert.equal(retriever.getSnippetCacheStats().misses, missesAfterFirst, 'semantic hit must not recompute');

    const semantic = retriever.getSemanticMemoStats();
    assert.equal(semantic.hits, 1);
    assert.equal(semantic.size, 1);
    assert.ok(semantic.threshold >= 0.9);

    // Query không liên quan vẫn phải dựng lại snippet.
    await retriever.retrieveContextSnippet('unrelated', { topK: 1 });
    assert.equal(retriever.getSnippetCacheStats().misses, missesAfterFirst + 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('semantic memo respects the threshold and the off switch', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-semantic-guard-'));
  const previous = process.env.MINUS_SEMANTIC_MEMO;
  try {
    const embed = (text: string): number[] => (text === 'gamma delta' ? [1, 0] : [0.99, 0.01]);

    // Ngưỡng 1.0: cosine < 1 nên không được coi là trùng.
    const strict = new TurnMemoryRetriever(root, { embedQuery: embed, semanticMemoThreshold: 1 });
    await strict.archiveTurns([{
      id: 't-guard', turnNumber: 1, userPrompt: 'gamma delta', assistantSummary: 'done',
      toolsUsed: [], filesTouched: [], keyDecisions: [], timestamp: new Date().toISOString(),
    }]);
    await strict.retrieveContextSnippet('gamma delta', { topK: 1 });
    await strict.retrieveContextSnippet('gamma delta again', { topK: 1 });
    assert.equal(strict.getSemanticMemoStats().hits, 0);
    assert.equal(strict.getSnippetCacheStats().misses, 2);

    // Off switch: ngay cả khi cosine cao cũng không tái dùng.
    process.env.MINUS_SEMANTIC_MEMO = 'off';
    const off = new TurnMemoryRetriever(root, { embedQuery: embed });
    await off.archiveTurns([{
      id: 't-off', turnNumber: 1, userPrompt: 'gamma delta', assistantSummary: 'done',
      toolsUsed: [], filesTouched: [], keyDecisions: [], timestamp: new Date().toISOString(),
    }]);
    await off.retrieveContextSnippet('gamma delta', { topK: 1 });
    await off.retrieveContextSnippet('gamma delta again', { topK: 1 });
    assert.equal(off.getSemanticMemoStats().hits, 0);
    assert.equal(off.getSemanticMemoStats().size, 0);
    assert.equal(off.getSnippetCacheStats().misses, 2);
  } finally {
    if (previous === undefined) delete process.env.MINUS_SEMANTIC_MEMO;
    else process.env.MINUS_SEMANTIC_MEMO = previous;
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
