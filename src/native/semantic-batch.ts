import { getNativeCore } from './index.js';

/** One native boundary crossing on current addons; older addons retain their existing path. */
export function batchSubwordSimilarity(query: string, documents: string[]): number[] | undefined {
  if (documents.length === 0) return [];
  if (process.env.MINUS_DISABLE_NATIVE_BATCH === '1') return undefined;
  const native = getNativeCore();
  if (!native) return undefined;
  try {
    if (typeof native.rsBatchSubwordSimilarity === 'function') {
      const scores = native.rsBatchSubwordSimilarity(query, documents);
      if (scores.length === documents.length && scores.every(Number.isFinite)) return scores;
      return undefined;
    }
    if (typeof native.rsGenerateSubwordEmbedding !== 'function' || typeof native.rsCosineSimilarity !== 'function') return undefined;
    const queryVector = native.rsGenerateSubwordEmbedding(query);
    const scores = documents.map((document) => native.rsCosineSimilarity(queryVector, native.rsGenerateSubwordEmbedding(document)));
    return scores.every(Number.isFinite) ? scores : undefined;
  } catch {
    return undefined;
  }
}
