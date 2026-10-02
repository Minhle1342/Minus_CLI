import { performance } from 'node:perf_hooks';
import { getNativeCore, type NativeGraphEdge, type NativeGraphScore } from '../src/native/index.js';

const native = getNativeCore();
if (!native?.RsCodeGraph || !native.rsBatchSubwordSimilarity) {
  throw new Error('Build the current addon with npm run native:build before benchmarking.');
}

function measure(run: () => void): { medianMs: number; p95Ms: number } {
  for (let i = 0; i < 20; i++) run();
  const samples: number[] = [];
  for (let i = 0; i < 120; i++) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return { medianMs: samples[60], p95Ms: samples[114] };
}

const ids = Array.from({ length: 1_200 }, (_, i) => `symbol-${i}`);
const edges: NativeGraphEdge[] = ids.flatMap((source, i) => [1, 7, 23]
  .map((step) => ({ source, target: ids[(i + step) % ids.length], weight: step === 1 ? 1.2 : 0.8 })));
const graph = new native.RsCodeGraph(ids, edges);
const seeds: NativeGraphScore[] = [0, 60, 300, 900].map((i) => ({ id: ids[i], score: 1 }));
const outgoing = new Map<string, Array<{ id: string; weight: number }>>();
const incoming = new Map<string, Array<{ id: string; weight: number }>>();
for (const edge of edges) {
  const out = outgoing.get(edge.source) || [];
  out.push({ id: edge.target, weight: edge.weight });
  outgoing.set(edge.source, out);
  const ins = incoming.get(edge.target) || [];
  ins.push({ id: edge.source, weight: edge.weight });
  incoming.set(edge.target, ins);
}
function jsPageRank(): void {
  const restart = new Map(seeds.map((seed) => [seed.id, seed.score / seeds.length]));
  let current = new Map(restart);
  for (let i = 0; i < 6; i++) {
    const next = new Map<string, number>();
    for (const [id, score] of current) {
      const neighbors = [...(outgoing.get(id) || []), ...(incoming.get(id) || [])];
      if (neighbors.length === 0) {
        next.set(id, (next.get(id) || 0) + score * 0.15);
        continue;
      }
      const total = neighbors.reduce((sum, edge) => sum + edge.weight, 0);
      for (const edge of neighbors) next.set(edge.id, (next.get(edge.id) || 0) + score * 0.85 * edge.weight / total);
    }
    for (const [id, score] of restart) next.set(id, (next.get(id) || 0) + 0.15 * score);
    current = next;
  }
  [...current].filter(([id]) => !restart.has(id)).sort((a, b) => b[1] - a[1]).slice(0, 12);
}
const graphJs = measure(jsPageRank);
const graphRust = measure(() => { graph.personalizedPageRankTop!(seeds, 'auto', 6, 0.85, 12); });

const query = 'inspect code symbol callers and dependencies';
const documents = Array.from({ length: 50 }, (_, i) => `tool_${i} inspect source file symbol graph diagnostics ${i}`);
function oldBatchPath(): void {
  const queryVector = native!.rsGenerateSubwordEmbedding(query);
  for (const document of documents) {
    native!.rsCosineSimilarity(queryVector, native!.rsGenerateSubwordEmbedding(document));
  }
}
const rerankOld = measure(oldBatchPath);
const rerankRust = measure(() => { native!.rsBatchSubwordSimilarity!(query, documents); });

const result = {
  graph: { ts: graphJs, rust: graphRust, p95Improvement: 1 - graphRust.p95Ms / graphJs.p95Ms },
  rerank: { old: rerankOld, rust: rerankRust, p95Improvement: 1 - rerankRust.p95Ms / rerankOld.p95Ms },
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
