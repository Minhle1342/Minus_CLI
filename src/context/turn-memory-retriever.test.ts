import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreVectorBatch } from './turn-memory-retriever.js';

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
