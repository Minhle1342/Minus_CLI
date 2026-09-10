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
  StepPromptPolicy?: any;
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

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue * sorted.length) - 1));
  return sorted[index];
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
  let promptPolicyModule: any;
  try {
    stepModule = await importAt(root, 'src/agent/step-retrieval-query-builder.ts', `${label}-step`);
  } catch {
    // The step-aware query builder was introduced after the baseline commit.
  }
  try {
    promptPolicyModule = await importAt(root, 'src/agent/step-prompt-policy.ts', `${label}-prompt-policy`);
  } catch {
    // Historical baselines use unconditional prompt injection.
  }
  return {
    label,
    root,
    ToolRetriever: retrieverModule.ToolRetriever,
    DynamicContextArbiter: arbiterModule.DynamicContextArbiter,
    TurnMemoryRetriever: memoryModule.TurnMemoryRetriever,
    StepRetrievalQueryBuilder: stepModule?.StepRetrievalQueryBuilder,
    StepPromptPolicy: promptPolicyModule?.StepPromptPolicy,
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

const allPromptBlocks = [
  'architecture', 'rootCause', 'mutation', 'longTask', 'subagent', 'dagPlan',
  'plan', 'advice', 'harness', 'scaffold',
];

function promptClassification(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: 'benchmark',
    version: 1,
    taskClass: 'question',
    phase: 'explore',
    complexity: 'small',
    externality: 'local',
    reversibility: 'read-only',
    risk: 'R0',
    requiredCapabilities: ['inspect'],
    confidence: 0.95,
    fastPath: false,
    reasonCodes: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function promptPolicyContext(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    activeStepQuery: 'Read the requested value and answer',
    fingerprint: 'benchmark-fingerprint',
    classification: promptClassification(),
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
    harnessProfileName: 'balanced-default',
    candidates: {
      legacyPlanContext: '[DYNAMIC EXECUTION PLAN]\nNo plan exists. A plan is optional.',
      stepPlanContext: '[STEP EXECUTION PLAN]\n1. Active task\nAcceptance: verified output',
      advicePrompt: '[NEXT ACTION ADVICE]\nUse the next appropriate tool and verify its result.',
      advicePlaybook: 'GENERAL',
      harnessGuidance: '[HARNESS PROFILE]\nFollow the active runtime verification profile.',
      scaffoldPrompt: '[COGNITIVE SCAFFOLD]\nInspect, falsify, mutate surgically, and verify.',
      legacyScaffoldPrompt: '[COGNITIVE SCAFFOLD]\nInspect, falsify, mutate surgically, and verify.',
    },
    ...overrides,
  };
}

const promptCases = [
  { input: promptPolicyContext(), required: [] },
  { input: promptPolicyContext({ activeStepQuery: 'Summarize README docs', harnessProfileName: 'read-only-guard' }), required: [] },
  { input: promptPolicyContext({ activeStepQuery: 'Map architecture topology and call graph dependencies' }), required: ['architecture'] },
  {
    input: promptPolicyContext({
      activeStepQuery: 'Debug root cause of authentication failure',
      classification: promptClassification({ taskClass: 'bugfix', phase: 'explore', requiredCapabilities: ['inspect', 'edit'] }),
      harnessProfileName: 'strict-verification',
    }),
    required: ['rootCause', 'harness', 'scaffold'],
  },
  {
    input: promptPolicyContext({
      activeStepQuery: 'Implement the accepted feature patch',
      classification: promptClassification({ taskClass: 'feature', phase: 'implement', requiredCapabilities: ['edit', 'verify'] }),
      harnessProfileName: 'velocity-first',
    }),
    required: ['mutation', 'harness'],
  },
  {
    input: promptPolicyContext({
      activeStepQuery: 'Run decisive regression verification',
      classification: promptClassification({ taskClass: 'bugfix', phase: 'verify', requiredCapabilities: ['verify'] }),
      harnessProfileName: 'strict-verification',
      hasValidatedHypothesis: true,
    }),
    required: ['rootCause', 'harness'],
  },
  {
    input: promptPolicyContext({ activeStepQuery: 'Poll running background server task', lastToolName: 'manage_task', lastToolResult: { status: 'running' } }),
    required: ['longTask'],
  },
  {
    input: promptPolicyContext({ activeStepQuery: 'Delegate parallel review to a subagent', classification: promptClassification({ requiredCapabilities: ['inspect', 'delegate'] }) }),
    required: ['subagent'],
  },
  {
    input: promptPolicyContext({
      activeStepQuery: 'Execute active planned task',
      classification: promptClassification({ taskClass: 'feature', phase: 'implement', requiredCapabilities: ['edit', 'plan'] }),
      hasPlan: true,
      planIncomplete: true,
      activeTask: { title: 'Implement parser', acceptanceCriteria: 'Tests pass' },
      harnessProfileName: 'velocity-first',
    }),
    required: ['mutation', 'dagPlan', 'plan', 'harness'],
  },
  {
    input: promptPolicyContext({ activeStepQuery: 'Try a different parser strategy', consecutiveFailures: 2, failureSignature: 'assertion failed', lastToolResult: { error: 'failed' } }),
    required: ['rootCause', 'advice', 'scaffold'],
  },
  {
    input: promptPolicyContext({ activeStepQuery: 'Ambiguous request', classification: promptClassification({ confidence: 0.6 }) }),
    required: allPromptBlocks,
  },
  {
    input: promptPolicyContext({ activeStepQuery: 'Return final answer', hasSubmittedSolution: true, visibleToolNames: [] }),
    required: ['advice'],
  },
];

async function runPromptGatingBenchmark(version: VersionModules): Promise<{
  promptBlockPrecision: number;
  requiredBlockRecall: number;
  tokenSavingsRatio: number;
  medianTokensBefore: number;
  medianTokensAfter: number;
  gateLatencyP50Ms: number;
  gateLatencyP95Ms: number;
  supported: boolean;
}> {
  let selectedCount = 0;
  let relevantSelected = 0;
  let requiredCount = 0;
  let recalledCount = 0;
  const beforeTokens: number[] = [];
  const afterTokens: number[] = [];
  const latencies: number[] = [];
  const promptPolicy = version.StepPromptPolicy ? new version.StepPromptPolicy() : undefined;

  for (let iteration = 0; iteration < iterations; iteration++) {
    for (const testCase of promptCases) {
      const started = performance.now();
      const decision = promptPolicy?.decide(testCase.input, 'enforce');
      latencies.push(performance.now() - started);
      const selected = decision
        ? [
          ...(decision.includeStaticToolPlaybooks
            ? allPromptBlocks.slice(0, 6)
            : decision.selectedPlaybooks),
          ...(decision.planContext ? ['plan'] : []),
          ...(decision.advicePrompt ? ['advice'] : []),
          ...(decision.harnessGuidance ? ['harness'] : []),
          ...(decision.scaffoldPrompt ? ['scaffold'] : []),
        ]
        : allPromptBlocks;
      const required = new Set(testCase.required);
      selectedCount += selected.length;
      relevantSelected += selected.filter((block: string) => required.has(block)).length;
      requiredCount += required.size;
      recalledCount += Array.from(required).filter((block) => selected.includes(block)).length;

      const legacyTokens = decision?.estimatedTokensBefore
        ?? Math.ceil((274 * 4 + Object.values(testCase.input.candidates).join('\n\n').length) / 4);
      beforeTokens.push(legacyTokens);
      afterTokens.push(decision?.injectedEstimatedTokens ?? legacyTokens);
    }
  }

  return {
    promptBlockPrecision: ratio(relevantSelected, selectedCount),
    requiredBlockRecall: ratio(recalledCount, requiredCount),
    tokenSavingsRatio: 1 - ratio(average(afterTokens), average(beforeTokens)),
    medianTokensBefore: percentile(beforeTokens, 0.5),
    medianTokensAfter: percentile(afterTokens, 0.5),
    gateLatencyP50Ms: percentile(latencies, 0.5),
    gateLatencyP95Ms: percentile(latencies, 0.95),
    supported: Boolean(promptPolicy),
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
  promptGating: Awaited<ReturnType<typeof runPromptGatingBenchmark>>;
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
  console.log(`Prompt-block precision                    ${baseline.promptGating.promptBlockPrecision.toFixed(4)}       ${candidate.promptGating.promptBlockPrecision.toFixed(4)}       ${delta(candidate.promptGating.promptBlockPrecision, baseline.promptGating.promptBlockPrecision)}`);
  console.log(`Required-block recall                     ${baseline.promptGating.requiredBlockRecall.toFixed(4)}       ${candidate.promptGating.requiredBlockRecall.toFixed(4)}       ${delta(candidate.promptGating.requiredBlockRecall, baseline.promptGating.requiredBlockRecall)}`);
  console.log(`Prompt token savings ratio                ${baseline.promptGating.tokenSavingsRatio.toFixed(4)}       ${candidate.promptGating.tokenSavingsRatio.toFixed(4)}       ${delta(candidate.promptGating.tokenSavingsRatio, baseline.promptGating.tokenSavingsRatio)}`);
  console.log(`Median gated prompt tokens                ${baseline.promptGating.medianTokensAfter.toFixed(1)}       ${candidate.promptGating.medianTokensAfter.toFixed(1)}`);
  console.log(`Synthetic composite score                 ${baseline.compositeScore.toFixed(4)}       ${candidate.compositeScore.toFixed(4)}       ${delta(candidate.compositeScore, baseline.compositeScore)}`);
  console.log('\nLatency (ms/case; lower is better)');
  console.log(`Tool retrieval                            ${baseline.tool.latencyMs.toFixed(3)}       ${candidate.tool.latencyMs.toFixed(3)}`);
  console.log(`Step query construction                  ${baseline.step.latencyMs.toFixed(3)}       ${candidate.step.latencyMs.toFixed(3)}`);
  console.log(`Context arbitration                       ${baseline.arbitration.latencyMs.toFixed(3)}       ${candidate.arbitration.latencyMs.toFixed(3)}`);
  console.log(`Memory retrieval                         ${baseline.memory.latencyMs.toFixed(3)}       ${candidate.memory.latencyMs.toFixed(3)}`);
  console.log(`Prompt gate p50                          ${baseline.promptGating.gateLatencyP50Ms.toFixed(3)}       ${candidate.promptGating.gateLatencyP50Ms.toFixed(3)}`);
  console.log(`Prompt gate p95                          ${baseline.promptGating.gateLatencyP95Ms.toFixed(3)}       ${candidate.promptGating.gateLatencyP95Ms.toFixed(3)}`);

  const improved = candidate.compositeScore > baseline.compositeScore;
  console.log(`\nVerdict: ${improved ? 'CANDIDATE IMPROVED' : 'NO COMPOSITE IMPROVEMENT'} on this deterministic benchmark.`);
  console.log('The composite score is a diagnostic proxy, not a claim of production task-success improvement.');
}

async function git(...args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd: projectRoot, maxBuffer: 2 * 1024 * 1024 });
  return result.stdout.trim();
}

async function main(): Promise<void> {
  const candidateHead = await git('rev-parse', 'HEAD');
  const candidateCommit = (await git('status', '--porcelain'))
    ? `${candidateHead}+worktree`
    : candidateHead;
  const worktreeRoot = path.join(projectRoot, 'temp', `context-benchmark-baseline-${Date.now()}-${process.pid}`);
  await fs.mkdir(path.dirname(worktreeRoot), { recursive: true });

  try {
    await git('worktree', 'add', '--detach', worktreeRoot, baselineRef);
    const [baseline, candidate] = await Promise.all([
      loadVersion(`baseline-${baselineRef}`, worktreeRoot),
      loadVersion(`candidate-${candidateHead.slice(0, 8)}`, projectRoot),
    ]);

    const reports = await Promise.all([baseline, candidate].map(async (version) => {
      const [tool, step, arbitration, memory, promptGating] = await Promise.all([
        runToolBenchmark(version),
        runStepBenchmark(version),
        runArbitrationBenchmark(version),
        runMemoryBenchmark(version),
        runPromptGatingBenchmark(version),
      ]);
      const partial = { label: version.label, tool, step, arbitration, memory, promptGating };
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
