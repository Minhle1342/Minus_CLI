import assert from 'node:assert';
import test from 'node:test';
import { Harness2RecursiveEngine, Harness2Bundle, type ProbeEvaluation } from './harness2-bridge.js';
import { CognitiveHarness } from './cognitive-harness.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

test('Harness2RecursiveEngine - Propose candidates for TypeScript bug task', () => {
  const harness = new CognitiveHarness();
  const engine = new Harness2RecursiveEngine();

  const baseScaffold = harness.createScaffold({
    request: 'Fix null pointer in auth.ts when token is missing',
    phase: 'implement',
  });

  const candidates = engine.proposeCandidates(baseScaffold, 'Fix null pointer in auth.ts when token is missing');

  assert.strictEqual(candidates.length, 3, 'Should generate base, inv1, and dom1 candidates');
  assert.strictEqual(candidates[0].id, 'base');
  assert.strictEqual(candidates[1].id, 'inv1');
  assert.strictEqual(candidates[2].id, 'dom1');

  // inv1 should have strict verification gates
  assert(candidates[1].scaffold.negativeGate.some(g => g.includes('NEVER modify existing test assertions')));

  // dom1 should have TypeScript-specific and Bug-specific gates
  assert(candidates[2].scaffold.negativeGate.some(g => g.includes('TypeScript')));
  assert(candidates[2].scaffold.negativeGate.some(g => g.includes('reproduce the defect')));
});

test('Harness2RecursiveEngine - Compose refined harness from probe contrasts', () => {
  const harness = new CognitiveHarness();
  const engine = new Harness2RecursiveEngine();

  const baseScaffold = harness.createScaffold({
    request: 'Refactor parser logic',
    phase: 'implement',
  });

  const candidates = engine.proposeCandidates(baseScaffold, 'Refactor parser logic');

  // Simulated probe evaluation where dom1 performs best
  const probeEvaluations = [
    { candidateId: 'base', toolCallCount: 8, unproductiveLoopsDetected: 2, testsPassed: false, score: 40, contrastNotes: [] },
    { candidateId: 'inv1', toolCallCount: 5, unproductiveLoopsDetected: 1, testsPassed: true, score: 75, contrastNotes: [] },
    { candidateId: 'dom1', toolCallCount: 4, unproductiveLoopsDetected: 0, testsPassed: true, score: 92, contrastNotes: [] },
  ];

  const result = engine.composeHarness(baseScaffold, candidates, probeEvaluations);

  assert.strictEqual(result.selectedCandidateId, 'dom1');
  assert(result.composedScaffold.executionTopology.some(s => s.includes('Harness² Pre-flight')));
  assert(result.composedScaffold.negativeGate.length >= baseScaffold.negativeGate.length);
});

test('Harness2RecursiveEngine - Export 8-component bundle to directory', async () => {
  const engine = new Harness2RecursiveEngine();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness2-bundle-test-'));

  try {
    const bundle: Harness2Bundle = {
      systemPrompt: 'You are MinusCLI Agent',
      guardrails: ['Do not mock tests', 'Verify with build'],
      memory: 'Project uses TypeScript 5.8',
      toolGuidance: {
        run_command: 'Use with caution',
      },
      subagents: {
        scout: { role: 'Scout Agent', instructions: 'Read only' },
      },
      skills: ['verification-policy', 'gitnexus-impact'],
      scripts: {},
      plugins: {},
    };

    await engine.exportBundleToDirectory(bundle, tempDir);

    const systemPromptExists = await fs.stat(path.join(tempDir, 'systemprompt.md')).then(() => true).catch(() => false);
    const guardrailsExists = await fs.stat(path.join(tempDir, 'guardrails.md')).then(() => true).catch(() => false);
    const memoryExists = await fs.stat(path.join(tempDir, 'LongTermMEMORY.md')).then(() => true).catch(() => false);
    const toolsDirExists = await fs.stat(path.join(tempDir, 'tool_descriptions', 'run_command.md')).then(() => true).catch(() => false);
    const subagentsDirExists = await fs.stat(path.join(tempDir, 'sub_agents', 'scout.json')).then(() => true).catch(() => false);

    assert(systemPromptExists, 'systemprompt.md should exist');
    assert(guardrailsExists, 'guardrails.md should exist');
    assert(memoryExists, 'LongTermMEMORY.md should exist');
    assert(toolsDirExists, 'tool_descriptions/run_command.md should exist');
    assert(subagentsDirExists, 'sub_agents/scout.json should exist');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('Harness2RecursiveEngine - Save and load persistent reflection library', async () => {
  const engine = new Harness2RecursiveEngine();
  const tmpFile = path.join(os.tmpdir(), `harness2-lib-test-${Date.now()}.json`);
  try {
    engine.reflectAndAccumulate({
      taskId: 'task-1',
      taskBrief: 'TypeScript division by zero fix',
      adoptedHarnessId: 'dom1',
      outcome: 'ok',
      lessonsLearned: ['Enforce strict zero-denominator check'],
      suggestedGuardrails: ['NEVER divide without prior non-zero assertion'],
      timestamp: new Date().toISOString(),
    });
    await engine.saveLibraryToFile(tmpFile);

    const loadedEngine = new Harness2RecursiveEngine();
    const count = await loadedEngine.loadLibraryFromFile(tmpFile);
    assert.strictEqual(count, 1);
    assert.strictEqual(loadedEngine.getLibrary().length, 1);

    const lessons = loadedEngine.findRelevantLessons('division zero');
    assert.ok(lessons.length > 0);
    assert(lessons[0].includes('zero-denominator'));
  } finally {
    await fs.rm(tmpFile, { force: true });
  }
});

test('Harness2RecursiveEngine - Evaluate candidate empirically with actual command execution', async () => {
  const engine = new Harness2RecursiveEngine();
  const candidate = {
    id: 'test-cand',
    kind: 'invariant' as const,
    description: 'Test invariant',
    scaffold: {
      category: 'code' as const,
      negativeGate: ['NEVER mock data'],
      falsificationCriteria: 'test fails',
      executionTopology: ['Step 1'],
      actionBoundary: 'Boundary',
    },
  };

  const evalResult = await engine.evaluateCandidateEmpirically(candidate, {
    testCommand: 'node -e "process.exit(0)"',
    cwd: process.cwd(),
    timeoutMs: 5000,
  });

  assert.strictEqual(evalResult.candidateId, 'test-cand');
  assert.strictEqual(evalResult.testsPassed, true);
  assert.ok(evalResult.score > 70);
  assert.ok(evalResult.contrastNotes.length > 0);
});

test('Harness2RecursiveEngine - Import 8-component bundle from directory (Two-Way Sync)', async () => {
  const engine = new Harness2RecursiveEngine();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness2-import-test-'));
  try {
    const bundle: Harness2Bundle = {
      systemPrompt: 'Test system prompt for 2-way sync',
      guardrails: ['Guardrail 1: Strict verification', 'Guardrail 2: No mocking'],
      memory: 'Temporal Knowledge Graph active',
      toolGuidance: {
        read_file: 'Inspect file context accurately',
        run_command: 'Run build command',
      },
      subagents: {
        scout: { role: 'Reconnaissance Scout', instructions: 'Read only operations' },
      },
      skills: ['verification-policy', 'gitnexus-impact'],
      scripts: { test: 'npm test' },
      plugins: { gitnexus: { enabled: true } },
    };

    await engine.exportBundleToDirectory(bundle, tmpDir);

    const imported = await engine.importBundleFromDirectory(tmpDir);
    assert.strictEqual(imported.systemPrompt, bundle.systemPrompt);
    assert.strictEqual(imported.guardrails.length, 2);
    assert.strictEqual(imported.guardrails[0], 'Guardrail 1: Strict verification');
    assert.strictEqual(imported.memory, bundle.memory);
    assert.strictEqual(imported.toolGuidance.read_file, 'Inspect file context accurately');
    assert.strictEqual(imported.subagents.scout.role, 'Reconnaissance Scout');
    assert.ok(imported.skills.includes('verification-policy'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('CognitiveHarness - Injects learned negative gates from Harness2 engine', () => {
  const engine = new Harness2RecursiveEngine();
  engine.reflectAndAccumulate({
    taskId: 'task-growth',
    taskBrief: 'Division by zero bug',
    adoptedHarnessId: 'dom1',
    outcome: 'ok',
    lessonsLearned: ['Always guard zero denominator'],
    suggestedGuardrails: ['NEVER divide by zero without prior check'],
    timestamp: new Date().toISOString(),
  });

  const harness = new CognitiveHarness();
  harness.setHarness2Engine(engine);
  const scaffold = harness.createScaffold({ request: 'Sửa lỗi division by zero' });

  assert.ok(scaffold.negativeGate.some(g => g.includes('NEVER divide by zero')));
});

test('Harness2RecursiveEngine - Propose specialized candidates for Plan mode', () => {
  const harness = new CognitiveHarness();
  const engine = new Harness2RecursiveEngine();

  const planScaffold = harness.createScaffold({
    request: 'Thiết kế kiến trúc hệ thống cache phân tán',
    phase: 'plan',
  });

  const candidates = engine.proposeCandidates(
    planScaffold,
    'Thiết kế kiến trúc hệ thống cache phân tán',
    { phase: 'plan' }
  );

  assert.strictEqual(candidates.length, 3);
  const invCandidate = candidates.find(c => c.id === 'inv1');
  assert.ok(invCandidate);
  assert.ok(invCandidate.scaffold.negativeGate.some(g => g.includes('PHASE LOCK: PLAN') || g.includes('NEVER attempt code mutations')));
  assert.ok(invCandidate.scaffold.executionTopology.some(s => s.includes('Architectural') || s.includes('Inspection') || s.includes('Dependency')));
});

test('Harness2RecursiveEngine - Propose specialized candidates for Implement mode', () => {
  const harness = new CognitiveHarness();
  const engine = new Harness2RecursiveEngine();

  const implementScaffold = harness.createScaffold({
    request: 'Sửa lỗi deadlock trong transaction pool',
    phase: 'implement',
  });

  const candidates = engine.proposeCandidates(
    implementScaffold,
    'Sửa lỗi deadlock trong transaction pool',
    { phase: 'implement' }
  );

  const invCandidate = candidates.find(c => c.id === 'inv1');
  assert.ok(invCandidate);
  assert.ok(invCandidate.scaffold.negativeGate.some(g => g.includes('reproduction test') || g.includes('mock test data')));
});

test('Harness2RecursiveEngine - Export and import bundle with phase-specific system prompts', async () => {
  const engine = new Harness2RecursiveEngine();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness2-phase-prompt-test-'));
  try {
    const bundle: Harness2Bundle = {
      systemPrompt: 'Generic system prompt fallback',
      systemPromptPlan: 'Dedicated Plan Mode Prompt: Architectural survey and DAG decomposition.',
      systemPromptImplement: 'Dedicated Implement Mode Prompt: Surgical mutation and empirical verification.',
      guardrails: ['No mocking'],
      memory: 'Project Memory',
      toolGuidance: {},
      subagents: {},
      skills: [],
      scripts: {},
      plugins: {},
    };

    await engine.exportBundleToDirectory(bundle, tmpDir);

    const planPromptExists = await fs.stat(path.join(tmpDir, 'systemprompt_plan.md')).then(() => true).catch(() => false);
    const implPromptExists = await fs.stat(path.join(tmpDir, 'systemprompt_implement.md')).then(() => true).catch(() => false);
    assert.strictEqual(planPromptExists, true, 'systemprompt_plan.md should exist');
    assert.strictEqual(implPromptExists, true, 'systemprompt_implement.md should exist');

    const imported = await engine.importBundleFromDirectory(tmpDir);
    assert.strictEqual(imported.systemPromptPlan, bundle.systemPromptPlan);
    assert.strictEqual(imported.systemPromptImplement, bundle.systemPromptImplement);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Harness2RecursiveEngine - Generate structured system prompt for Plan and Implement phases', () => {
  const engine = new Harness2RecursiveEngine();

  const planPrompt = engine.generatePhaseSystemPrompt('plan', ['Focus on call graph exploration']);
  assert.ok(planPrompt.includes('PHASE: PLAN'));
  assert.ok(planPrompt.includes('Focus on call graph exploration'));
  assert.ok(planPrompt.includes('FORBIDDEN') || planPrompt.includes('read-only') || planPrompt.includes('Survey and plan ONLY') || planPrompt.includes('ARCHITECTURAL'));

  const implementPrompt = engine.generatePhaseSystemPrompt('implement', ['Require reproduction test']);
  assert.ok(implementPrompt.includes('PHASE: IMPLEMENT'));
  assert.ok(implementPrompt.includes('Require reproduction test'));
  assert.ok(implementPrompt.includes('Surgical') || implementPrompt.includes('surgical') || implementPrompt.includes('atomic') || implementPrompt.includes('MUTATION'));
});

test('Harness2RecursiveEngine - Generate standard tool guidance catalog for core tools', () => {
  const engine = new Harness2RecursiveEngine();
  const catalog = (engine as any).generateStandardToolGuidanceCatalog();

  // Must cover core tools
  const coreTools = ['read_file', 'replace_text', 'apply_patch', 'run_command', 'get_diagnostics', 'codegraph_explore', 'analyze_impact', 'create_plan', 'submit_solution', 'spawn_agent'];
  for (const tool of coreTools) {
    assert.ok(catalog[tool], `Catalog must contain guidance for ${tool}`);
    assert.ok(catalog[tool].length > 30, `Guidance for ${tool} must be informative`);
  }
});

test('Harness2RecursiveEngine - Generate phase-differentiated tool guidance', () => {
  const engine = new Harness2RecursiveEngine();
  
  const planCatalog = (engine as any).generateStandardToolGuidanceCatalog({ phase: 'plan' });
  assert.ok(planCatalog.replace_text.includes('PHASE LOCK') || planCatalog.replace_text.includes('FORBIDDEN'));
  assert.ok(planCatalog.apply_patch.includes('PHASE LOCK') || planCatalog.apply_patch.includes('FORBIDDEN'));
  assert.ok(planCatalog.read_file.includes('primary') || planCatalog.read_file.includes('Survey') || planCatalog.read_file.includes('Inspect') || planCatalog.read_file.includes('read-only'));

  const implCatalog = (engine as any).generateStandardToolGuidanceCatalog({ phase: 'implement' });
  assert.ok(implCatalog.replace_text.includes('read_file') || implCatalog.replace_text.includes('get_diagnostics') || implCatalog.replace_text.includes('PREREQUISITE'));
  assert.ok(implCatalog.apply_patch.includes('diff') || implCatalog.apply_patch.includes('patch') || implCatalog.apply_patch.includes('hunk'));
});

test('Harness2RecursiveEngine - Propose candidates with specialized tool guidance', () => {
  const harness = new CognitiveHarness();
  const engine = new Harness2RecursiveEngine();
  const baseScaffold = harness.createScaffold({ request: 'Refactor auth controller', phase: 'implement' });

  const candidates = engine.proposeCandidates(baseScaffold, 'Refactor auth controller', { phase: 'implement' });
  const invCandidate = candidates.find(c => c.id === 'inv1');
  const domCandidate = candidates.find(c => c.id === 'dom1');

  assert.ok(invCandidate?.toolGuidance, 'Invariant candidate must specify specialized tool guidance');
  assert.ok(
    invCandidate.toolGuidance.replace_text.includes('STRICT') ||
    invCandidate.toolGuidance.replace_text.includes('Strict') ||
    invCandidate.toolGuidance.replace_text.includes('prerequisite') ||
    invCandidate.toolGuidance.replace_text.includes('read_file')
  );

  assert.ok(domCandidate?.toolGuidance, 'Domain candidate must specify specialized tool guidance');
});

test('Harness2RecursiveEngine - Compose refined tool guidance in composeHarness', () => {
  const harness = new CognitiveHarness();
  const engine = new Harness2RecursiveEngine();
  const baseScaffold = harness.createScaffold({ request: 'Fix null pointer in parser', phase: 'implement' });
  const candidates = engine.proposeCandidates(baseScaffold, 'Fix null pointer in parser', { phase: 'implement' });
  
  const evaluations: ProbeEvaluation[] = [
    { candidateId: 'base', score: 50, testsPassed: true, toolCallCount: 6, unproductiveLoopsDetected: 1, contrastNotes: [] },
    { candidateId: 'inv1', score: 85, testsPassed: true, toolCallCount: 4, unproductiveLoopsDetected: 0, contrastNotes: [] },
    { candidateId: 'dom1', score: 70, testsPassed: true, toolCallCount: 5, unproductiveLoopsDetected: 0, contrastNotes: [] },
  ];

  const result = engine.composeHarness(baseScaffold, candidates, evaluations);
  assert.strictEqual(result.selectedCandidateId, 'inv1');
  assert.ok((result.composedScaffold as any).toolGuidance);
  assert.ok((result.composedScaffold as any).toolGuidance.replace_text);
});

test('Harness2RecursiveEngine - Export and import comprehensive tool descriptions', async () => {
  const engine = new Harness2RecursiveEngine();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness2-tools-bundle-test-'));
  try {
    const fullCatalog = engine.generateStandardToolGuidanceCatalog({ phase: 'implement' });
    const bundle: Harness2Bundle = {
      systemPrompt: 'MinusCLI Agent',
      guardrails: ['No mock'],
      memory: 'Project Memory',
      toolGuidance: fullCatalog,
      subagents: {},
      skills: [],
      scripts: {},
      plugins: {},
    };

    await engine.exportBundleToDirectory(bundle, tmpDir);

    const toolsDir = path.join(tmpDir, 'tool_descriptions');
    const exportedFiles = await fs.readdir(toolsDir);
    assert.ok(exportedFiles.length >= 10, `Expected at least 10 tool descriptions, found ${exportedFiles.length}`);
    assert.ok(exportedFiles.includes('read_file.md'));
    assert.ok(exportedFiles.includes('replace_text.md'));
    assert.ok(exportedFiles.includes('apply_patch.md'));
    assert.ok(exportedFiles.includes('get_diagnostics.md'));

    const imported = await engine.importBundleFromDirectory(tmpDir);
    assert.strictEqual(Object.keys(imported.toolGuidance).length, exportedFiles.length);
    assert.strictEqual(imported.toolGuidance.read_file, fullCatalog.read_file);
    assert.strictEqual(imported.toolGuidance.replace_text, fullCatalog.replace_text);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});










