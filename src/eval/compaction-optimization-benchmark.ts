import { performance } from 'node:perf_hooks';
import { ContextCompactor } from '../agent/context-compactor.js';
import { ContextBudgetManager } from '../agent/context-budget-manager.js';
import { selectReplacedObservationIds } from '../agent/observation-retention-policy.js';

// Deterministic local fixture: no LLM calls, no workspace mutation, no claim
// about semantic task accuracy or provider-side cache hit rate.
const history: any[] = [{ role: 'user', parts: [{ text: 'Preserve invariant ACTIVE_TASK' }] }];
for (let i = 0; i < 12; i++) {
  history.push({ role: 'model', parts: [{ functionCall: { id: `read-${i}`, name: 'read_file', args: { path: 'active.ts' } } }] });
  history.push({ role: 'user', parts: [{ functionResponse: { id: `read-${i}`, name: 'read_file',
    response: { path: 'active.ts', content: 'const activeInvariant = true;\n'.repeat(1000) } } }] });
}
const envelope = { provider: 'test', model: 'gemini-test', systemPrompt: 'Coding agent', tools: [], history,
  maxInputTokens: 40000, outputReserveTokens: 1000 };
const replaced = selectReplacedObservationIds(history);
const reports = [];
for (const selective of [false, true]) {
  const compactor = new ContextCompactor();
  const compact = compactor.compact.bind(compactor);
  let candidates = 0;
  compactor.compact = (...args) => { candidates++; return compact(...args); };
  const manager = new ContextBudgetManager(compactor, { mode: 'enforce' });
  const options = { protectActiveTurn: true, protectedMessages: history, protectedPaths: ['active.ts'],
    replacedObservationIds: selective ? replaced : [] };
  const start = performance.now();
  const result = await manager.prepareRequest(envelope, options);
  const firstMs = performance.now() - start;
  const repeatStart = performance.now();
  const nextEnvelope = { ...envelope, history: result.history };
  await manager.prepareRequest(nextEnvelope, options);
  const repeatMs = performance.now() - repeatStart;
  const warmRepeatStart = performance.now();
  await manager.prepareRequest(nextEnvelope, options);
  const warmRepeatMs = performance.now() - warmRepeatStart;
  const archives = result.compactionStats?.maskedObservations || [];
  let retainedPrefix = 0;
  for (let i = 0; i < result.history.length; i++) {
    if (JSON.stringify(result.history[i]) !== JSON.stringify(history[i])) break;
    retainedPrefix++;
  }
  reports.push({ policy: selective ? 'selective-replacements' : 'fully-pinned',
    firstMs: +firstMs.toFixed(2), repeatMs: +repeatMs.toFixed(2), warmRepeatMs: +warmRepeatMs.toFixed(2), candidateAttempts: candidates,
    beforeTokens: result.before.upperBoundTokens, afterTokens: result.after.upperBoundTokens,
    savedTokens: result.before.upperBoundTokens - result.after.upperBoundTokens,
    withinBudget: result.withinBudget, unchangedPrefixMessages: retainedPrefix,
    latestSnapshotRetained: JSON.stringify(result.history.at(-1)) === JSON.stringify(history.at(-1)),
    archivedOriginalsRecoverableInResult: archives.every((record) => record.originalPayload?.content?.includes('activeInvariant')),
    archivedObservations: archives.length });
}
console.log(JSON.stringify({ fixture: '12 identical snapshots in one active turn',
  limitations: ['synthetic fixture only', 'archive payload check is not an end-to-end disk recall test',
    'unchangedPrefixMessages is a proxy, not a provider cache-hit measurement'], reports }, null, 2));
