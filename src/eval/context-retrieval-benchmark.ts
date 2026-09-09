import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baselineRef = process.argv.find((arg) => arg.startsWith('--baseline='))?.slice('--baseline='.length) || '2f48540';
const iterations = Math.max(1, Number(process.argv.find((arg) => arg.startsWith('--iterations='))?.slice('--iterations='.length) || 5));

type VersionModules = {
  label: string;
  root: string;
  ToolRetriever: any;
  DynamicContextArbiter: any;
  TurnMemoryRetriever: any;
  StepRetrievalQueryBuilder?: any;
};

type ToolCase = { query: string; expected: string };

const toolCases: ToolCase[] = [
  { query: 'architecture dependency impact', expected: 'inspect_symbol_edges' },
  { query: 'architecture blast radius dependency', expected: 'query_call_graph' },
  { query: 'architecture service boundary dependency', expected: 'analyze_symbol_flow' },
  { query: 'architecture topology layers', expected: 'map_route_dependencies' },
];

const distractors = [
  ['archive_bundle', 'Packages selected artifacts.'],
  ['plan_queue', 'Maintains work items.'],
  ['memory_digest', 'Stores compact notes.'],
  ['render_preview', 'Renders a visual preview.'],
  ['format_report', 'Formats a report for display.'],
].map(([name, description]) => ({
  name,
  description,
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ success: true }),
}));

function makeToolCorpus(targetName: string): any[] {
  const target = {
    name: targetName,
    description: 'Shows structural relationships in source code.',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ success: true }),
  };
  return [distractors[0], target, ...distractors.slice(1)];
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 1;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function importAt(root: string, relativePath: string, label: string): Promise<any> {
  const absolute = path.resolve(root, relativePath);
  return import(`${pathToFileURL(absolute).href}?context-benchmark=${label}`);
}

async function loadVersion(label: string, root: string): Promise<VersionModules> {
  const [retrieverModule, arbiterModule, memoryModule] = await Promise.all([
    importAt(root, 'src/tools/tool-retriever.ts', `${label}-retriever`),
    importAt(root, 'src/agent/dynamic-context-arbiter.ts', `${label}-arbiter`),
    importAt(root, 'src/context/turn-memory-retriever.ts', `${label}-memory`),
  ]);
  let stepModule: any;
  try {
    stepModule = await importAt(root, 'src/agent/step-retrieval-query-builder.ts', `${label}-step`);
  } catch {
    // The step-aware query builder was introduced after the baseline commit.
  }
  return {
    label,
    root,
    ToolRetriever: retrieverModule.ToolRetriever,
    DynamicContextArbiter: arbiterModule.DynamicContextArbiter,
    TurnMemoryRetriever: memoryModule.TurnMemoryRetriever,
    StepRetrievalQueryBuilder: stepModule?.StepRetrievalQueryBuilder,
  };
}

async function runToolBenchmark(version: VersionModules): Promise<{
  recallAtK: number;
  unnecessaryRate: number;
  latencyMs: number;
}> {
  let hits = 0;
  let selected = 0;
  let unnecessary = 0;
  const started = performance.now();

  for (let iteration = 0; iteration < iterations; iteration++) {
    for (const testCase of toolCases) {
      const retriever = new version.ToolRetriever({
        enabled: true,
        activationThreshold: 0,
        topK: 1,
        alwaysInclude: [],
        minScore: 0.05,
      });
      const tools = makeToolCorpus(testCase.expected);
      retriever.indexTools(tools);
      const names = retriever.retrieve(testCase.query, tools).map((tool: any) => tool.name);
      if (names.includes(testCase.expected)) hits++;
      selected += names.length;
      unnecessary += names.filter((name: string) => name !== testCase.expected).length;
    }
  }

  const total = toolCases.length * iterations;
  return {
    recallAtK: ratio(hits, total),
    unnecessaryRate: ratio(unnecessary, selected),
    latencyMs: (performance.now() - started) / total,
  };
}

type StepCase = {
  userRequest: string;
  activeTask: { title: string; acceptanceCriteria: string; readSet: string[]; symbols: string[] };
  phase: string;
  taskClass: string;
  lastToolName: string;
  lastToolResult: Record<string, string>;
  expectedTerms: string[];
};

const stepCases: StepCase[] = [
  {
    userRequest: 'Fix authentication refresh flow',
    activeTask: {
      title: 'Repair auth interceptor',
      acceptanceCriteria: 'Tests pass',
      readSet: ['src/auth/interceptor.ts'],
      symbols: ['AuthInterceptor'],
    },
    phase: 'explore',
    taskClass: 'bugfix',
    lastToolName: 'run_command',
    lastToolResult: { error: 'TypeError in src/auth/service.ts at AuthService.refreshToken' },
    expectedTerms: ['src/auth/service.ts', 'AuthService.refreshToken'],
  },
  {
    userRequest: 'Repair checkout timeout handling',
    activeTask: {
      title: 'Investigate payment retry',
      acceptanceCriteria: 'No duplicate charge',
      readSet: ['src/payments/retry.ts'],
      symbols: ['PaymentRetry'],
    },
    phase: 'fault_localization',
    taskClass: 'bugfix',
    lastToolName: 'get_diagnostics',
    lastToolResult: { failure: 'TimeoutError at src/payments/gateway.ts in Gateway.charge' },
    expectedTerms: ['src/payments/gateway.ts', 'Gateway.charge'],
  },
];

function legacyStepQuery(testCase: StepCase): string {
  return [
    testCase.userRequest,
    testCase.activeTask.title,
    testCase.activeTask.acceptanceCriteria,
  ].filter(Boolean).join(' ');
}

async function runStepBenchmark(version: VersionModules): Promise<{
  evidenceCoverage: number;
  failureSignatureCoverage: number;
  latencyMs: number;
  supported: boolean;
}> {
  const builder = version.StepRetrievalQueryBuilder ? new version.StepRetrievalQueryBuilder() : undefined;
  let covered = 0;
  let totalTerms = 0;
  let failureSignatures = 0;
  const started = performance.now();

  for (let iteration = 0; iteration < iterations; iteration++) {
    for (const testCase of stepCases) {
      const state = builder?.build({
        userRequest: testCase.userRequest,
        activeTask: testCase.activeTask,
        phase: testCase.phase,
        taskClass: testCase.taskClass,
        lastToolName: testCase.lastToolName,
        lastToolResult: testCase.lastToolResult,
        allowedToolNames: ['read_file', 'get_diagnostics'],
      });
      const query = state?.query || legacyStepQuery(testCase);
      totalTerms += testCase.expectedTerms.length;
      covered += testCase.expectedTerms.filter((term) => query.includes(term)).length;
      if (state?.failureSignature) failureSignatures++;
    }
  }

  const totalCases = stepCases.length * iterations;
  return {
    evidenceCoverage: ratio(covered, totalTerms),
    failureSignatureCoverage: ratio(failureSignatures, totalCases),
    latencyMs: (performance.now() - started) / totalCases,
    supported: Boolean(builder),
  };
}

const arbitrationCases = [
  { query: 'auth token interceptor refresh', marker: 'AUTH_RELEVANT_EVIDENCE' },
  { query: 'database connection pool timeout', marker: 'DB_RELEVANT_EVIDENCE' },
];

function arbitrationInputs(marker: string): Record<string, string> {
  const unrelated = Array.from({ length: 7 }, (_, index) => `UNRELATED_${index}: CSS animation and visual styling evidence.`);
  const relevant = marker === 'AUTH_RELEVANT_EVIDENCE'
    ? `${marker}: auth token interceptor refresh implementation and failure evidence must be inspected before patching.`
    : `${marker}: database connection pool timeout implementation and failure evidence must be inspected before patching.`;
  return {
    advicePrompt: 'P1_REQUIRED_INSTRUCTION',
    rawPlanContext: 'P2_ACCEPTANCE_CRITERIA',
    recalledTurnContext: ['[TURN MEMORY]', ...unrelated, relevant].join('\n\n'),
  };
}

async function runArbitrationBenchmark(version: VersionModules): Promise<{
  relevantRetention: number;
  priorityPreservation: number;
  averageTokensSaved: number;
  latencyMs: number;
}> {
  let relevantRetained = 0;
  let priorityPreserved = 0;
  const tokenSavings: number[] = [];
  const started = performance.now();

  for (let iteration = 0; iteration < iterations; iteration++) {
    for (const testCase of arbitrationCases) {
      const result = new version.DynamicContextArbiter(80).arbitrate(
        arbitrationInputs(testCase.marker),
        {
          maxBudgetTokens: 80,
          retrievalQuery: testCase.query,
          modelName: 'gemini-2.5-flash',
        },
      );
      if (result.renderedContext.includes(testCase.marker)) relevantRetained++;
      const p1 = result.renderedContext.indexOf('P1_REQUIRED_INSTRUCTION');
      const p2 = result.renderedContext.indexOf('P2_ACCEPTANCE_CRITERIA');
      if (p1 >= 0 && p2 >= 0 && p1 < p2) priorityPreserved++;
      tokenSavings.push(result.stats.tokensSaved);
    }
  }

  const totalCases = arbitrationCases.length * iterations;
  return {
    relevantRetention: ratio(relevantRetained, totalCases),
    priorityPreservation: ratio(priorityPreserved, totalCases),
    averageTokensSaved: average(tokenSavings),
    latencyMs: (performance.now() - started) / totalCases,
  };
}

async function runMemoryBenchmark(version: VersionModules): Promise<{
  staleFullExemplarLeak: number;
  validFullExemplarPreservation: number;
  latencyMs: number;
}> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `minus-context-${version.label}-`));
  const sourcePath = path.join(workspace, 'src', 'auth.ts');
  const oldSource = 'export function refreshToken() { return "old"; }\n';
  const newSource = 'export function refreshToken() { return "new"; }\n';
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, oldSource, 'utf8');

  try {
    const retriever = new version.TurnMemoryRetriever(workspace);
    await retriever.recordEpisodicExperience({
      id: 'oauth-refresh-experience',
      taskIntent: 'Fix OAuth2 token refresh in AuthInterceptor',
      rootCause: 'Refresh token was not awaited.',
      faultLocalizedEntities: ['src/auth.ts'],
      patchSummary: 'Await the refresh operation before continuing.',
      verificationCommand: 'npm test',
      verificationExitCode: 0,
    });

    const started = performance.now();
    const validResults = [] as any[];
    const staleResults = [] as any[];
    for (let iteration = 0; iteration < iterations; iteration++) {
      validResults.push(await retriever.retrieveDualMemory('Fix OAuth2 token refresh in AuthInterceptor', {
        activeFiles: ['src/auth.ts'],
        topK: 2,
        minScore: 0.55,
      }));
    }
    await fs.writeFile(sourcePath, newSource, 'utf8');
    for (let iteration = 0; iteration < iterations; iteration++) {
      staleResults.push(await retriever.retrieveDualMemory('Fix OAuth2 token refresh in AuthInterceptor', {
        activeFiles: ['src/auth.ts'],
        topK: 2,
        minScore: 0.55,
      }));
    }

    const staleFull = staleResults.filter((result) => result.episodicExemplars.some((item: any) => item.gatingTier === 'full_exemplar')).length;
    const validFull = validResults.filter((result) => result.episodicExemplars.some((item: any) => item.gatingTier === 'full_exemplar')).length;
    return {
      staleFullExemplarLeak: ratio(staleFull, staleResults.length),
      validFullExemplarPreservation: ratio(validFull, validResults.length),
      latencyMs: (performance.now() - started) / (iterations * 2),
    };
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

type VersionReport = {
  label: string;
  tool: Awaited<ReturnType<typeof runToolBenchmark>>;
  step: Awaited<ReturnType<typeof runStepBenchmark>>;
  arbitration: Awaited<ReturnType<typeof runArbitrationBenchmark>>;
  memory: Awaited<ReturnType<typeof runMemoryBenchmark>>;
  compositeScore: number;
};

function score(report: Omit<VersionReport, 'compositeScore'>): number {
  const staleSafety = 1 - report.memory.staleFullExemplarLeak;
  const toolPrecision = 1 - report.tool.unnecessaryRate;
  return round(
    report.tool.recallAtK * 0.25
      + toolPrecision * 0.10
      + report.step.evidenceCoverage * 0.20
      + report.arbitration.relevantRetention * 0.25
      + staleSafety * 0.15
      + report.memory.validFullExemplarPreservation * 0.03
      + report.arbitration.priorityPreservation * 0.02,
  );
}

function printReport(baseline: VersionReport, candidate: VersionReport, candidateCommit: string): void {
  const delta = (candidateValue: number, baselineValue: number): string => {
    const change = round(candidateValue - baselineValue);
    return `${change >= 0 ? '+' : ''}${change}`;
  };
  console.log('\n=== Context Retrieval / Reasoning Benchmark ===');
  console.log(`Baseline: ${baselineRef} | Candidate: ${candidateCommit} | Iterations: ${iterations}`);
  console.log('\nMetric                                      Baseline     Candidate    Delta');
  console.log(`Tool recall@K                              ${baseline.tool.recallAtK.toFixed(4)}       ${candidate.tool.recallAtK.toFixed(4)}       ${delta(candidate.tool.recallAtK, baseline.tool.recallAtK)}`);
  console.log(`Tool unnecessary rate                      ${baseline.tool.unnecessaryRate.toFixed(4)}       ${candidate.tool.unnecessaryRate.toFixed(4)}       ${delta(candidate.tool.unnecessaryRate, baseline.tool.unnecessaryRate)}`);
  console.log(`Step evidence coverage                    ${baseline.step.evidenceCoverage.toFixed(4)}       ${candidate.step.evidenceCoverage.toFixed(4)}       ${delta(candidate.step.evidenceCoverage, baseline.step.evidenceCoverage)}`);
  console.log(`Failure signature coverage                ${baseline.step.failureSignatureCoverage.toFixed(4)}       ${candidate.step.failureSignatureCoverage.toFixed(4)}       ${delta(candidate.step.failureSignatureCoverage, baseline.step.failureSignatureCoverage)}`);
  console.log(`Relevant context retention                ${baseline.arbitration.relevantRetention.toFixed(4)}       ${candidate.arbitration.relevantRetention.toFixed(4)}       ${delta(candidate.arbitration.relevantRetention, baseline.arbitration.relevantRetention)}`);
  console.log(`P1/P2 priority preservation               ${baseline.arbitration.priorityPreservation.toFixed(4)}       ${candidate.arbitration.priorityPreservation.toFixed(4)}       ${delta(candidate.arbitration.priorityPreservation, baseline.arbitration.priorityPreservation)}`);
  console.log(`Stale full-exemplar leakage               ${baseline.memory.staleFullExemplarLeak.toFixed(4)}       ${candidate.memory.staleFullExemplarLeak.toFixed(4)}       ${delta(candidate.memory.staleFullExemplarLeak, baseline.memory.staleFullExemplarLeak)}`);
  console.log(`Valid full-exemplar preservation          ${baseline.memory.validFullExemplarPreservation.toFixed(4)}       ${candidate.memory.validFullExemplarPreservation.toFixed(4)}       ${delta(candidate.memory.validFullExemplarPreservation, baseline.memory.validFullExemplarPreservation)}`);
  console.log(`Synthetic composite score                 ${baseline.compositeScore.toFixed(4)}       ${candidate.compositeScore.toFixed(4)}       ${delta(candidate.compositeScore, baseline.compositeScore)}`);
  console.log('\nLatency (ms/case; lower is better)');
  console.log(`Tool retrieval                            ${baseline.tool.latencyMs.toFixed(3)}       ${candidate.tool.latencyMs.toFixed(3)}`);
  console.log(`Step query construction                  ${baseline.step.latencyMs.toFixed(3)}       ${candidate.step.latencyMs.toFixed(3)}`);
  console.log(`Context arbitration                       ${baseline.arbitration.latencyMs.toFixed(3)}       ${candidate.arbitration.latencyMs.toFixed(3)}`);
  console.log(`Memory retrieval                         ${baseline.memory.latencyMs.toFixed(3)}       ${candidate.memory.latencyMs.toFixed(3)}`);

  const improved = candidate.compositeScore > baseline.compositeScore;
  console.log(`\nVerdict: ${improved ? 'CANDIDATE IMPROVED' : 'NO COMPOSITE IMPROVEMENT'} on this deterministic benchmark.`);
  console.log('The composite score is a diagnostic proxy, not a claim of production task-success improvement.');
}

async function git(...args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd: projectRoot, maxBuffer: 2 * 1024 * 1024 });
  return result.stdout.trim();
}

async function main(): Promise<void> {
  const candidateCommit = await git('rev-parse', 'HEAD');
  const worktreeRoot = path.join(projectRoot, 'temp', `context-benchmark-baseline-${Date.now()}-${process.pid}`);
  await fs.mkdir(path.dirname(worktreeRoot), { recursive: true });

  try {
    await git('worktree', 'add', '--detach', worktreeRoot, baselineRef);
    const [baseline, candidate] = await Promise.all([
      loadVersion(`baseline-${baselineRef}`, worktreeRoot),
      loadVersion(`candidate-${candidateCommit.slice(0, 8)}`, projectRoot),
    ]);

    const reports = await Promise.all([baseline, candidate].map(async (version) => {
      const [tool, step, arbitration, memory] = await Promise.all([
        runToolBenchmark(version),
        runStepBenchmark(version),
        runArbitrationBenchmark(version),
        runMemoryBenchmark(version),
      ]);
      const partial = { label: version.label, tool, step, arbitration, memory };
      return { ...partial, compositeScore: score(partial) } as VersionReport;
    }));

    printReport(reports[0], reports[1], candidateCommit);
  } finally {
    await git('worktree', 'remove', '--force', worktreeRoot).catch(() => {});
    await fs.rm(worktreeRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('Context benchmark failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
