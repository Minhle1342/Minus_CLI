import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BenchmarkRunner } from './benchmark-runner.js';
import { BENCHMARK_TASKS } from './benchmark-tasks.js';
import type { BenchmarkTask, TaskEvaluationResult } from './types.js';
import { StepPromptPolicy } from '../agent/step-prompt-policy.js';

dotenv.config();

const modelName = process.argv.find((arg) => arg.startsWith('--model='))?.slice('--model='.length)
  || 'gemini-3.7-flash';
const iterations = Math.max(1, Number(process.argv.find((arg) => arg.startsWith('--iterations='))?.slice('--iterations='.length) || 5));
const outputPath = path.resolve(
  process.argv.find((arg) => arg.startsWith('--output='))?.slice('--output='.length)
    || `logs/evaluations/prompt-gating-live-${Date.now()}.json`,
);

const readOnlySource = 'export const timeoutMs = 2500;\nexport const retryCount = 3;\n';
const readOnlyTask: BenchmarkTask = {
  id: 'task-read-only-config-explanation',
  title: 'Read-only configuration explanation',
  description: 'Read and explain two configuration values without modifying the workspace.',
  category: 'context',
  difficulty: 'easy',
  prompt: 'Read src/config.js and explain the timeout and retry behavior in a concise final answer. Do not edit files and do not run tests.',
  initialFiles: [{ path: 'src/config.js', content: readOnlySource }],
  readOnly: true,
  maxSteps: 5,
  timeoutMs: 90_000,
  verifyFn: async ({ workspaceDir }) => ({
    success: await fs.readFile(path.join(workspaceDir, 'src/config.js'), 'utf8') === readOnlySource,
    message: 'Read-only source remained unchanged.',
  }),
};

function task(id: string): BenchmarkTask {
  const found = BENCHMARK_TASKS.find((item) => item.id === id);
  if (!found) throw new Error(`Missing benchmark task: ${id}`);
  return found;
}

const tasks: BenchmarkTask[] = [
  readOnlyTask,
  task('task-bugfix-growth-rate'),
  task('task-feature-validator'),
  task('task-context-distractor-disambiguation'),
];

type Mode = 'off' | 'enforce';
type Sample = {
  mode: Mode;
  taskId: string;
  round: number;
  warmup: boolean;
  result: TaskEvaluationResult;
};

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
}

function median(values: number[]): number {
  return percentile(values, 0.5);
}

function deterministicRequiredBlockRecall(): number {
  const policy = new StepPromptPolicy();
  const base = {
    fingerprint: 'live-benchmark-audit',
    hasPlan: false,
    planRequired: false,
    planIncomplete: false,
    planBlocked: false,
    readyTaskCount: 0,
    visibleToolNames: ['read_file'],
    consecutiveFailures: 0,
    hasValidatedHypothesis: false,
    hasSubmittedSolution: false,
    hasVerifiedTests: false,
    activeAgentCount: 0,
    harnessProfileName: 'balanced-default' as const,
    candidates: {
      legacyPlanContext: 'legacy plan',
      stepPlanContext: 'step plan',
      advicePrompt: 'advice',
      advicePlaybook: 'GENERAL',
      harnessGuidance: 'harness',
      scaffoldPrompt: 'scaffold',
      legacyScaffoldPrompt: 'scaffold',
    },
  };
  const classification = (overrides: Record<string, any> = {}) => ({
    id: 'audit', version: 1, taskClass: 'question', phase: 'explore', complexity: 'small',
    externality: 'local', reversibility: 'read-only', risk: 'R0', requiredCapabilities: ['inspect'],
    confidence: 0.95, fastPath: false, reasonCodes: [], createdAt: new Date(0).toISOString(), ...overrides,
  });
  const cases = [
    { input: { ...base, activeStepQuery: 'architecture topology dependency call graph', classification: classification() }, required: ['architecture'] },
    { input: { ...base, activeStepQuery: 'debug root cause failure', classification: classification({ taskClass: 'bugfix', requiredCapabilities: ['inspect', 'edit'] }), harnessProfileName: 'strict-verification' }, required: ['rootCause', 'harness', 'scaffold'] },
    { input: { ...base, activeStepQuery: 'implement patch', classification: classification({ taskClass: 'feature', phase: 'implement', requiredCapabilities: ['edit'] }), harnessProfileName: 'velocity-first' }, required: ['mutation', 'harness'] },
    { input: { ...base, activeStepQuery: 'poll background server task', classification: classification(), lastToolName: 'manage_task', lastToolResult: { status: 'running' } }, required: ['longTask'] },
    { input: { ...base, activeStepQuery: 'delegate parallel subagent review', classification: classification({ requiredCapabilities: ['delegate'] }) }, required: ['subagent'] },
    { input: { ...base, activeStepQuery: 'execute active plan', classification: classification({ phase: 'plan', requiredCapabilities: ['plan'] }), planRequired: true, hasPlan: true, planIncomplete: true }, required: ['dagPlan', 'plan'] },
  ];
  let expected = 0;
  let recalled = 0;
  for (const testCase of cases) {
    const decision = policy.decide(testCase.input as any, 'enforce');
    const selected = new Set([
      ...decision.selectedPlaybooks,
      ...(decision.planContext ? ['plan'] : []),
      ...(decision.harnessGuidance ? ['harness'] : []),
      ...(decision.scaffoldPrompt ? ['scaffold'] : []),
    ]);
    expected += testCase.required.length;
    recalled += testCase.required.filter((block) => selected.has(block as any)).length;
  }
  return expected > 0 ? recalled / expected : 1;
}

async function execute(mode: Mode, benchmarkTask: BenchmarkTask, round: number, warmup: boolean): Promise<Sample> {
  const runner = new BenchmarkRunner({
    modelName,
    requireLiveModel: true,
    stepPromptGatingMode: mode,
    mockMode: false,
    keepWorkspaces: false,
    sandboxBaseDir: path.resolve('temp', 'prompt-gating-live', `${mode}-r${round}-${benchmarkTask.id}`),
  });
  const result = await runner.runSingleTask(benchmarkTask);
  return { mode, taskId: benchmarkTask.id, round, warmup, result };
}

function summarize(samples: Sample[], mode: Mode): Record<string, any> {
  const selected = samples.filter((sample) => !sample.warmup && sample.mode === mode);
  return {
    mode,
    sampleCount: selected.length,
    passed: selected.filter((sample) => sample.result.status === 'PASSED').length,
    passRate: selected.length ? selected.filter((sample) => sample.result.status === 'PASSED').length / selected.length : 0,
    medianPromptTokens: median(selected.map((sample) => sample.result.metrics.tokens.promptTokens)),
    medianTimeToFinalAnswerMs: median(selected.map((sample) => sample.result.metrics.timeToFinalAnswerMs)),
    p95TimeToFinalAnswerMs: percentile(selected.map((sample) => sample.result.metrics.timeToFinalAnswerMs), 0.95),
    medianModelRequestTimeMs: median(selected.map((sample) => sample.result.metrics.totalModelRequestTimeMs)),
    medianSteps: median(selected.map((sample) => sample.result.metrics.stepsTaken)),
    medianToolCalls: median(selected.map((sample) => sample.result.metrics.toolCallsCount)),
    medianGuardianInterventions: median(selected.map((sample) => sample.result.metrics.guardianInterventionsCount)),
    ttftP50Ms: median(selected.map((sample) => sample.result.metrics.ttftP50Ms)),
    ttftP95Ms: percentile(selected.map((sample) => sample.result.metrics.ttftP95Ms), 0.95),
  };
}

async function main(): Promise<void> {
  const samples: Sample[] = [];
  for (let round = 0; round <= iterations; round++) {
    const warmup = round === 0;
    const order: Mode[] = round % 2 === 0 ? ['off', 'enforce'] : ['enforce', 'off'];
    for (const benchmarkTask of tasks) {
      for (const mode of order) {
        console.log(`[${warmup ? 'warm-up' : `round ${round}/${iterations}`}] ${mode} ${benchmarkTask.id}`);
        samples.push(await execute(mode, benchmarkTask, round, warmup));
      }
    }
  }

  const off = summarize(samples, 'off');
  const enforce = summarize(samples, 'enforce');
  const requiredBlockRecall = deterministicRequiredBlockRecall();
  const baselinePassKeys = new Set(samples.filter((sample) => !sample.warmup && sample.mode === 'off' && sample.result.status === 'PASSED').map((sample) => `${sample.taskId}:${sample.round}`));
  const candidatePassKeys = new Set(samples.filter((sample) => !sample.warmup && sample.mode === 'enforce' && sample.result.status === 'PASSED').map((sample) => `${sample.taskId}:${sample.round}`));
  const allBaselinePassesPreserved = Array.from(baselinePassKeys).every((key) => candidatePassKeys.has(key));
  const promptTokenReduction = off.medianPromptTokens > 0 ? 1 - enforce.medianPromptTokens / off.medianPromptTokens : 0;
  const finalLatencyReduction = off.medianTimeToFinalAnswerMs > 0 ? 1 - enforce.medianTimeToFinalAnswerMs / off.medianTimeToFinalAnswerMs : 0;
  const gates = {
    allBaselinePassesPreserved,
    groundTruthPassRateNotReduced: enforce.passRate >= off.passRate,
    requiredBlockRecall100: requiredBlockRecall === 1,
    medianPromptTokensReduced15Percent: promptTokenReduction >= 0.15,
    medianFinalLatencyReduced10Percent: finalLatencyReduction >= 0.10,
    p95FinalLatencyIncreaseWithin5Percent: enforce.p95TimeToFinalAnswerMs <= off.p95TimeToFinalAnswerMs * 1.05,
    medianStepsNotIncreased: enforce.medianSteps <= off.medianSteps,
    medianToolCallsNotIncreased: enforce.medianToolCalls <= off.medianToolCalls,
    medianGuardianInterventionsNotIncreased: enforce.medianGuardianInterventions <= off.medianGuardianInterventions,
  };
  const report = {
    generatedAt: new Date().toISOString(),
    modelName,
    iterations,
    warmupRoundsExcluded: 1,
    taskIds: tasks.map((item) => item.id),
    requiredBlockRecall,
    promptTokenReduction,
    finalLatencyReduction,
    off,
    enforce,
    gates,
    verdict: Object.values(gates).every(Boolean) ? 'ENFORCE_QUALIFIED' : 'KEEP_SHADOW',
    samples,
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ ...report, samples: `[${samples.length} samples omitted]` }, null, 2));
  console.log(`Report: ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
