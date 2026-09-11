import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluateParetoCandidate,
  requiredPairedRunsForNonInferiority,
  selectParetoCandidate,
  type PairedCompactionSample,
} from './compaction-pareto.js';

function samples(count: number, cost: number): PairedCompactionSample[] {
  return Array.from({ length: count }, (_, index) => ({
    taskId: `task-${index}`,
    baselinePassed: true,
    candidatePassed: true,
    candidateCost: cost,
    candidateLatencyMs: 10,
  }));
}

test('small suites are reported as inconclusive for a one-point margin', () => {
  const report = evaluateParetoCandidate('candidate', samples(13, 10));
  assert.equal(report.statisticallyConclusive, false);
  assert.equal(report.feasible, false);
  assert(requiredPairedRunsForNonInferiority(0) > 13);
});

test('selector chooses the cheapest safe non-dominated candidate after the gate', () => {
  const count = requiredPairedRunsForNonInferiority(0);
  const expensive = evaluateParetoCandidate('expensive', samples(count, 10));
  const cheap = evaluateParetoCandidate('cheap', samples(count, 6));
  const unsafeSamples = samples(count, 2);
  unsafeSamples[0].hardBudgetOverflow = true;
  const unsafe = evaluateParetoCandidate('unsafe', unsafeSamples);
  const result = selectParetoCandidate([expensive, cheap, unsafe]);

  assert.equal(result.verdict, 'SELECTED');
  assert.equal(result.selected?.id, 'cheap');
  assert.equal(result.reports.find((item) => item.id === 'expensive')?.dominated, true);
  assert.equal(unsafe.feasible, false);
});
