import assert from 'node:assert';
import test from 'node:test';
import { Harness2RecursiveEngine, Harness2Bundle } from './harness2-bridge.js';
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



