import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { ContextCompactor, type CompactionConfig } from '../agent/context-compactor.js';
import {
  ContextBudgetManager,
  type CompactionStateV1,
} from '../agent/context-budget-manager.js';
import {
  evaluateParetoCandidate,
  selectParetoCandidate,
  type PairedCompactionSample,
} from './compaction-pareto.js';

type Language = 'en' | 'vi' | 'mixed';
type Position = 'early' | 'middle' | 'late';

interface PolicySpec {
  id: string;
  mode: 'legacy' | 'enforce';
  config: CompactionConfig;
}

const policies: PolicySpec[] = [
  { id: 'legacy', mode: 'legacy', config: { preserveLastNTurns: 8, preserveLastNToolResults: 3 } },
  { id: 'balanced', mode: 'enforce', config: { preserveLastNTurns: 8, preserveLastNToolResults: 3, maskOldObservationsBeyondN: 3 } },
  { id: 'aggressive', mode: 'enforce', config: { preserveLastNTurns: 4, preserveLastNToolResults: 1, maskOldObservationsBeyondN: 1, maxCharactersPerToolResult: 600 } },
];

function fact(language: Language, position: Position, variant: number): string {
  const variable = 7319 + variant;
  const file = `src/context/state-${variant}.ts`;
  if (language === 'vi') return `QUYẾT ĐỊNH_${position}: giữ biến số ${variable} và tệp ${file}`;
  if (language === 'mixed') return `DECISION_${position}: giữ biến số ${variable} in ${file}`;
  return `DECISION_${position}: preserve variable ${variable} in ${file}`;
}

function makeHistory(language: Language, position: Position, payloadChars: number, variant: number): any[] {
  const history: any[] = [
    { role: 'user', parts: [{ text: language === 'vi' ? 'Kiểm tra luồng ngữ cảnh dài.' : 'Inspect the long context flow.' }] },
    { role: 'model', parts: [{ text: 'Objective acknowledged.' }] },
  ];
  const factTurn = position === 'early' ? 1 : position === 'middle' ? 5 : 9;
  for (let turn = 1; turn <= 10; turn++) {
    const callId = `call-${turn}`;
    history.push({ role: 'user', parts: [{ text: `Turn ${turn}: inspect evidence.` }] });
    history.push({
      role: 'model',
      parts: [
        { text: turn === factTurn ? fact(language, position, variant) : `Turn ${turn} evidence collected for variant ${variant}.` },
        { functionCall: { id: callId, name: 'read_file', args: { path: `src/file-${turn}.ts` } } },
      ],
    });
    history.push({
      role: 'user',
      parts: [{
        functionResponse: {
          id: callId,
          name: 'read_file',
          response: { path: `src/file-${turn}.ts`, content: `${String.fromCharCode(97 + (variant % 26)).repeat(Math.floor(payloadChars / 10))}\nexport const value${turn} = ${turn + variant};` },
        },
      }],
    });
  }
  return history;
}

async function runPolicy(policy: PolicySpec, repeats: number): Promise<PairedCompactionSample[]> {
  const samples: PairedCompactionSample[] = [];
  for (let variant = 0; variant < repeats; variant++) {
    for (const language of ['en', 'vi', 'mixed'] as Language[]) {
      for (const position of ['early', 'middle', 'late'] as Position[]) {
        for (const payloadChars of [8_000, 16_000, 32_000, 64_000]) {
          let history = makeHistory(language, position, payloadChars, variant);
        let previousState: CompactionStateV1 | undefined;
        let totalLatencyMs = 0;
        let result;
        for (let generation = 0; generation < 4; generation++) {
          const compactor = new ContextCompactor({
            maxTotalHistoryTokens: 8_000,
            enableRollingTurnCompaction: true,
            enableObservationMasking: true,
            ...policy.config,
          });
          const manager = new ContextBudgetManager(compactor, { mode: policy.mode, triggerRatio: 0.55 });
          const started = performance.now();
          result = await manager.prepareRequest({
            provider: 'benchmark',
            model: language === 'vi' ? 'gemini-benchmark' : 'gpt-benchmark',
            systemPrompt: 'Coding agent benchmark.',
            tools: [],
            history,
            maxInputTokens: 8_000,
            outputReserveTokens: 500,
          }, { previousState, preserveLastNTurns: policy.config.preserveLastNTurns });
          totalLatencyMs += performance.now() - started;
          history = result.history;
          previousState = result.state || previousState;
          history = [
            ...history,
            { role: 'user', parts: [{ text: `Generation ${generation + 1} follow-up` }] },
            { role: 'model', parts: [{ text: `Generation ${generation + 1} complete` }] },
          ];
        }
        if (!result) throw new Error('Benchmark did not produce a result.');
        const requiredFact = fact(language, position, variant);
        const projected = JSON.stringify(result.history);
        const stateText = JSON.stringify(result.state || {});
        samples.push({
          taskId: `${variant}-${language}-${position}-${payloadChars}`,
          baselinePassed: true,
          candidatePassed: projected.includes(requiredFact) || stateText.includes(requiredFact),
          candidateCost: result.after.upperBoundTokens,
          candidateLatencyMs: totalLatencyMs,
          hardBudgetOverflow: !result.withinBudget,
        });
        }
      }
    }
  }
  return samples;
}

async function main(): Promise<void> {
  const repeatArg = process.argv.find((arg) => arg.startsWith('--repeats='));
  const repeats = Math.max(1, Number.parseInt(repeatArg?.slice('--repeats='.length) || '1', 10) || 1);
  const reports = [];
  for (const policy of policies) {
    reports.push(evaluateParetoCandidate(policy.id, await runPolicy(policy, repeats)));
  }
  const selection = selectParetoCandidate(reports);
  const output = {
    benchmark: 'compaction-pareto-diagnostic',
    repeats,
    note: 'Synthetic retention is a smoke benchmark; production selection remains inconclusive until the paired power gate is met.',
    verdict: selection.verdict,
    selected: selection.selected?.id,
    reports: selection.reports.map((report) => ({
      id: report.id,
      samples: report.samples.length,
      passRate: report.passRate,
      qualityDelta: report.qualityDelta,
      qualityDeltaLower95: report.qualityDeltaLower95,
      meanInputUpperBound: report.meanCost,
      p95LatencyMs: report.p95LatencyMs,
      safe: report.safe,
      statisticallyConclusive: report.statisticallyConclusive,
      requiredPairedRuns: report.requiredPairedRuns,
      feasible: report.feasible,
      dominated: report.dominated,
    })),
  };
  console.log(JSON.stringify(output, null, 2));
  const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
  if (outputArg) await fs.writeFile(outputArg.slice('--output='.length), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  if (process.argv.includes('--require-conclusive') && selection.verdict !== 'SELECTED') {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
