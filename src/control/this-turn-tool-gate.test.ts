import assert from 'node:assert/strict';
import test from 'node:test';
import { ClassificationEngine } from './classification-engine.js';
import { ThisTurnToolGate, createToolSurface } from './this-turn-tool-gate.js';
import { ToolRegistry } from '../tools/registry.js';
import { PlanManager } from '../agent/plan-manager.js';
import { registerSubmitSolutionTool } from '../tools/submit-solution.js';
import { ToolRunner } from '../tools/tool-runner.js';
import { Workspace } from '../workspace/workspace.js';
import { PermissionManager } from '../security/permission-manager.js';
import { CognitiveHarness } from '../agent/cognitive-harness.js';
import { Session } from '../session/session.js';
import { applyPhaseAuthority, getPhaseTransitionRecoveryGuidance, requestPhaseTransition } from '../agent/phase-lifecycle.js';
import { buildPhaseToolAuthorityDirective } from '../llm/prompt-sections.js';
import { createBrowserTools, BROWSER_TOOL_NAMES } from '../tools/browser-tools.js';

test('Playwright browser tools are authorized in every phase (explore included)', () => {
  const gate = new ThisTurnToolGate();
  const tools = createBrowserTools({} as any);
  for (const phase of ['explore', 'plan', 'implement', 'verify', 'release'] as const) {
    const decision = gate.decide({
      id: `class-browser-${phase}`,
      version: 1,
      taskClass: 'exploration',
      phase,
      complexity: 'small',
      externality: 'local',
      reversibility: 'read-only',
      risk: 'R0',
      requiredCapabilities: ['inspect', 'search', 'memory'],
      confidence: 0.9,
      fastPath: true,
      reasonCodes: [],
      createdAt: new Date().toISOString(),
    } as any, tools);
    for (const name of BROWSER_TOOL_NAMES) {
      assert.ok(decision.allowedToolNames.includes(name), `${name} must be allowed in ${phase}`);
    }
  }
});

test('read-only exploration can inspect Git history through guarded run_command', async () => {
  const workspace = new Workspace(process.cwd());
  const registry = new ToolRegistry();
  const classification = new ClassificationEngine().classify({
    request: 'Explain how the current implementation relates to recent commits',
  });
  const decision = new ThisTurnToolGate().decide(classification, registry.getAll());

  assert.equal(classification.risk, 'R0');
  assert.ok(decision.allowedToolNames.includes('run_command'));

  const scope = registry.createScope('read-only-git-history', decision.allowedToolNames);
  const runner = new ToolRunner(scope, workspace, new PermissionManager('ask_sensitive'));
  const context = {
    decisionId: decision.id,
    allowedToolNames: decision.allowedToolNames,
    allowedToolSetHash: decision.allowedToolSetHash,
    maxToolCalls: decision.maxToolCalls,
    userRequest: 'Explain how the current implementation relates to recent commits',
  };
  const gitLog = await runner.run('run_command', { command: 'git log -n 5 --stat' }, context);
  assert.equal(gitLog.result.exitCode, 0);

  const mutationAttempt = await runner.run('run_command', {
    command: 'npm install package-that-must-not-run',
  }, context);
  assert.equal(mutationAttempt.result.errorCode, 'APPROVAL_REQUIRED');
});

test('adaptive tool budget scales generously for hard tasks and large complexity', () => {
  const registry = new ToolRegistry();
  const gate = new ThisTurnToolGate();

  // Hard task: large complexity, R3 risk
  const hardClassification: any = {
    id: 'class-test-hard-1',
    taskClass: 'bugfix',
    phase: 'explore',
    complexity: 'large',
    risk: 'R3',
    requiredCapabilities: ['inspect', 'search', 'plan'],
    reversibility: 'reversible',
  };
  const decisionHard = gate.decide(hardClassification, registry.getAll());
  // Budget should scale up to accommodate deep exploration on hard tasks (>= 20)
  assert.ok(decisionHard.maxToolCalls >= 20, `Expected maxToolCalls >= 20, got ${decisionHard.maxToolCalls}`);

  // Critical task in implement phase
  const criticalImplement: any = {
    id: 'class-test-crit-1',
    taskClass: 'refactor',
    phase: 'implement',
    complexity: 'large',
    risk: 'R4',
    requiredCapabilities: ['edit', 'inspect', 'verify'],
    reversibility: 'hard-to-reverse',
  };
  const decisionCrit = gate.decide(criticalImplement, registry.getAll());
  // Previously was capped at 2! Now should be at least 14
  assert.ok(decisionCrit.maxToolCalls >= 14, `Expected maxToolCalls >= 14, got ${decisionCrit.maxToolCalls}`);
});

test('phase-specific exploration anchors stay visible after dynamic retrieval', () => {
  const names = [
    'read_file', 'list_files', 'search_text', 'search_codebase_fast', 'codegraph_search', 'codegraph_explore',
    'get_symbol_context_360', 'get_diagnostics', 'codegraph_impact', 'analyze_impact',
    'get_architecture_topology', 'run_command',
  ];
  const tools = names.map((name) => ({
    name,
    description: name,
    parameters: { type: 'OBJECT', properties: {} },
    execute: async () => ({}),
  } as any));
  const gate = new ThisTurnToolGate();
  const decideDefault = (phase: string) => gate.decide({
    id: `class-anchor-${phase}`,
    taskClass: 'bugfix',
    phase,
    complexity: 'small',
    risk: 'R1',
    requiredCapabilities: ['inspect', 'search'],
    reversibility: 'reversible',
  } as any, tools).phaseExploreToolAnchors;

  // By default (no .codegraph/ index and not an architecture query), CodeGraph anchors are filtered out to save tokens
  assert.deepEqual(decideDefault('explore'), ['read_file', 'list_files', 'search_text', 'search_codebase_fast', 'get_symbol_context_360', 'get_diagnostics']);
  assert.deepEqual(decideDefault('plan'), ['read_file', 'search_text', 'analyze_impact', 'get_symbol_context_360', 'get_architecture_topology']);
  assert.deepEqual(decideDefault('implement'), ['read_file', 'get_symbol_context_360', 'get_diagnostics']);
  assert.deepEqual(decideDefault('verify'), ['read_file', 'get_diagnostics', 'run_command']);

  // When hasCodeGraph = true or isArchitectureQuery = true, CodeGraph tools are activated
  const decideWithCodeGraph = (phase: string) => gate.decide({
    id: `class-anchor-cg-${phase}`,
    taskClass: 'bugfix',
    phase,
    complexity: 'small',
    risk: 'R1',
    requiredCapabilities: ['inspect', 'search'],
    reversibility: 'reversible',
  } as any, tools, { hasCodeGraph: true }).phaseExploreToolAnchors;

  assert.deepEqual(decideWithCodeGraph('explore'), ['read_file', 'list_files', 'search_text', 'search_codebase_fast', 'codegraph_search', 'codegraph_explore', 'get_symbol_context_360', 'get_diagnostics']);
  assert.deepEqual(decideWithCodeGraph('plan'), ['read_file', 'search_text', 'codegraph_explore', 'codegraph_impact', 'analyze_impact', 'get_symbol_context_360', 'get_architecture_topology']);

  const decideWithArchQuery = (phase: string) => gate.decide({
    id: `class-anchor-arch-${phase}`,
    taskClass: 'bugfix',
    phase,
    complexity: 'small',
    risk: 'R1',
    requiredCapabilities: ['inspect', 'search'],
    reversibility: 'reversible',
  } as any, tools, { userRequest: 'Explain the architecture and call graph' }).phaseExploreToolAnchors;

  assert.deepEqual(decideWithArchQuery('explore'), ['read_file', 'list_files', 'search_text', 'search_codebase_fast', 'codegraph_search', 'codegraph_explore', 'get_symbol_context_360', 'get_diagnostics']);

  const decision = gate.decide({
    id: 'class-anchor-surface',
    taskClass: 'bugfix',
    phase: 'explore',
    complexity: 'small',
    risk: 'R1',
    requiredCapabilities: ['inspect', 'search'],
    reversibility: 'reversible',
  } as any, tools);
  assert.deepEqual(decision.toolSurface.authorizedToolNames, decision.allowedToolNames);
  assert.deepEqual(decision.toolSurface.visibleToolNames, [...decision.phaseExploreToolAnchors].sort());
});

test('ToolSurface keeps LLM-visible tools inside the authorized allowlist', () => {
  const surface = createToolSurface(['run_command', 'read_file'], ['read_file', 'missing_tool', 'read_file']);

  assert.deepEqual(surface.authorizedToolNames, ['read_file', 'run_command']);
  assert.deepEqual(surface.visibleToolNames, ['read_file']);
});

test('phase-based tool scoping supports Unified Agentic Loop for coding tasks and guards read-only exploration', () => {
  const registry = new ToolRegistry(new PlanManager());
  registerSubmitSolutionTool(registry, new Workspace(process.cwd()));
  const gate = new ThisTurnToolGate();

  // 1. Explore phase on a coding task is read-only; the model must request implementation.
  const exploreClassification: any = {
    id: 'class-test-explore',
    taskClass: 'bugfix',
    phase: 'explore',
    complexity: 'medium',
    risk: 'R2',
    requiredCapabilities: ['inspect', 'search', 'plan', 'execute', 'edit'],
    reversibility: 'reversible',
  };
  const exploreDecision = gate.decide(exploreClassification, registry.getAll());
  assert.ok(exploreDecision.allowedToolNames.includes('read_file'), 'read_file must be allowed');
  assert.ok(exploreDecision.allowedToolNames.includes('formulate_and_verify_hypothesis'), 'formulate_and_verify_hypothesis must be allowed');
  assert.ok(exploreDecision.allowedToolNames.includes('web_search'), 'web_search must be allowed in explore');
  assert.ok(exploreDecision.allowedToolNames.includes('replace_text'), 'replace_text is allowed in explore phase');
  assert.ok(exploreDecision.allowedToolNames.includes('submit_solution'), 'submit_solution must be exposed in explore');
  assert.ok(exploreDecision.allowedToolNames.includes('request_phase_transition'), 'coding exploration can request a Harness-owned transition');

  // 2. Pure read-only exploration (edit tools still available for immediate fixes)
  const readOnlyClassification: any = {
    id: 'class-test-readonly',
    taskClass: 'exploration',
    phase: 'explore',
    complexity: 'medium',
    risk: 'R0',
    requiredCapabilities: ['inspect', 'search'],
    reversibility: 'reversible',
  };
  const readOnlyDecision = gate.decide(readOnlyClassification, registry.getAll());
  assert.ok(readOnlyDecision.allowedToolNames.includes('read_file'), 'read_file must be allowed in read-only');
  assert.ok(readOnlyDecision.allowedToolNames.includes('replace_text'), 'replace_text is allowed in explore phase');
  assert.ok(readOnlyDecision.allowedToolNames.includes('submit_solution'), 'submit_solution must be allowed in pure read-only exploration');

  const operationsDecision = gate.decide({ ...readOnlyClassification, taskClass: 'operations' }, registry.getAll());
  assert.equal(
    operationsDecision.allowedToolNames.includes('request_phase_transition'),
    false,
    'non-coding tasks must not advertise a coding-only phase transition request',
  );

  // 3. Implement phase on feature
  const implementClassification: any = {
    id: 'class-test-implement',
    taskClass: 'feature',
    phase: 'implement',
    complexity: 'medium',
    risk: 'R2',
    requiredCapabilities: ['edit', 'inspect', 'execute', 'plan', 'complete'],
    reversibility: 'reversible',
  };
  const implementDecision = gate.decide(implementClassification, registry.getAll());
  assert.ok(implementDecision.allowedToolNames.includes('replace_text'), 'replace_text must be allowed in implement');
  assert.ok(implementDecision.allowedToolNames.includes('apply_patch'), 'apply_patch must be allowed in implement');
  assert.ok(implementDecision.allowedToolNames.includes('run_node_script'), 'run_node_script must be allowed in implement');
  assert.ok(implementDecision.allowedToolNames.includes('update_plan_task'), 'update_plan_task must be allowed in implement');
  assert.ok(implementDecision.allowedToolNames.includes('submit_solution'), 'submit_solution must be allowed in implement');
  assert.ok(implementDecision.allowedToolNames.includes('web_search'), 'web_search must be allowed in implement');

  // 4. Verify phase
  const verifyClassification: any = {
    id: 'class-test-verify',
    taskClass: 'bugfix',
    phase: 'verify',
    complexity: 'small',
    risk: 'R1',
    requiredCapabilities: ['verify', 'execute', 'inspect', 'complete'],
    reversibility: 'reversible',
  };
  const verifyDecision = gate.decide(verifyClassification, registry.getAll());
  assert.ok(verifyDecision.allowedToolNames.includes('run_command'), 'run_command must be allowed in verify');
  assert.ok(verifyDecision.allowedToolNames.includes('submit_solution'), 'submit_solution must be allowed in verify');
  assert.ok(verifyDecision.allowedToolNames.includes('get_diagnostics'), 'get_diagnostics must be allowed in verify');
  assert.ok(verifyDecision.allowedToolNames.includes('update_plan_task'), 'update_plan_task must be allowed in verify');
  assert.ok(verifyDecision.allowedToolNames.includes('replace_text'), 'replace_text is available in verify under Unified Agentic Loop for quick adjustments');
});

test('ClassificationEngine scopes an explicit planning request and preserves plan on failure', () => {
  const engine = new ClassificationEngine();

  // An explicit planning request enters plan phase without edit/complete authority.
  const planClassification = engine.classify({
    request: '[PLANNING MODE REQUEST]: Lập kế hoạch triển khai toàn bộ kiến trúc hệ thống mới cho module auth',
  });
  assert.equal(planClassification.phase, 'plan');
  assert.equal(planClassification.requiredCapabilities.includes('edit'), false, 'plan phase must NOT have edit capability');
  assert.equal(planClassification.requiredCapabilities.includes('complete'), false, 'plan phase must NOT have complete capability');
  assert.ok(planClassification.requiredCapabilities.includes('plan'), 'plan phase must have plan capability');

  // Bug 2: Failure during plan phase must preserve plan phase and not fall into exploration trap
  const recoveredFromPlan = engine.classify({
    request: '[PLANNING MODE REQUEST]: Lập kế hoạch triển khai toàn bộ kiến trúc hệ thống mới cho module auth',
    previous: planClassification,
    lastToolName: 'create_plan',
    lastToolFailed: true,
  });
  assert.equal(recoveredFromPlan.phase, 'plan', 'failure during plan phase must preserve plan phase');
  assert.ok(recoveredFromPlan.requiredCapabilities.includes('plan'), 'recovered plan must retain plan capability');
  assert.ok(recoveredFromPlan.reasonCodes.includes('FAILED_ACTION_PRESERVE_PLAN_CAPABILITY'));

  // Bug 3: Multi-file mutation does not get prematurely locked out of edit when hasUnverifiedChanges is true
  const initialImplement = engine.classify({
    request: 'Cập nhật mã nguồn hàm authenticate và thay thế token generator',
  });
  assert.equal(initialImplement.phase, 'implement');
  assert.ok(initialImplement.requiredCapabilities.includes('edit'));

  const secondFileMutation = engine.classify({
    request: 'Cập nhật mã nguồn hàm authenticate và thay thế token generator',
    previous: initialImplement,
    hasUnverifiedChanges: true,
    lastToolName: 'replace_text',
  });
  assert.equal(secondFileMutation.phase, 'implement', 'subsequent file edit in implement must remain in implement phase');
  assert.ok(secondFileMutation.requiredCapabilities.includes('edit'), 'must retain edit capability for multi-file changes');

  // Bug 4: replace and thay the regex recognition
  const replaceEn = engine.classify({ request: 'Replace the JWT token verification in auth.ts' });
  assert.equal(replaceEn.taskClass, 'feature');
  assert.ok(replaceEn.requiredCapabilities.includes('edit'));

  const replaceVi = engine.classify({ request: 'Thay thế cấu hình cổng kết nối database' });
  assert.equal(replaceVi.taskClass, 'feature');
  assert.ok(replaceVi.requiredCapabilities.includes('edit'));

  // Bug 5: Slash command prefix in read-only analysis
  const slashCommandExploration = engine.classify({ request: '/open-code-review Đánh giá kiến trúc hệ thống' });
  assert.equal(slashCommandExploration.taskClass, 'exploration');
  assert.equal(slashCommandExploration.phase, 'explore');
  assert.equal(slashCommandExploration.requiredCapabilities.includes('edit'), false);
});

test('ToolRunner authorizes canonical tool aliases (write_to_file, replace_file_content) under enforce mode', async () => {
  const workspace = new Workspace(process.cwd());
  const registry = new ToolRegistry(new PlanManager());
  const gate = new ThisTurnToolGate();

  const implementClassification: any = {
    id: 'class-test-alias',
    taskClass: 'feature',
    phase: 'implement',
    complexity: 'medium',
    risk: 'R2',
    requiredCapabilities: ['edit', 'inspect', 'verify'],
    reversibility: 'reversible',
  };
  const decision = gate.decide(implementClassification, registry.getAll());
  const scope = registry.createScope('alias-test-scope', decision.allowedToolNames);
  const runner = new ToolRunner(scope, workspace, new PermissionManager('ask_sensitive'));

  const context: any = {
    decisionId: decision.id,
    allowedToolNames: decision.allowedToolNames,
    allowedToolSetHash: decision.allowedToolSetHash,
    classificationPhase: 'implement',
    controlMode: 'enforce',
    turn: 1,
  };

  // replace_file_content is an alias for replace_text; write_to_file is an alias for write_file
  assert.ok(decision.allowedToolNames.includes('replace_text'));
  assert.ok(decision.allowedToolNames.includes('write_file'));

  // Calling replace_file_content with invalid path will fail at validation/lookup stage, NOT at Stage 0 authorization!
  const res = await runner.run('replace_file_content', {
    TargetFile: 'non_existent_file_test.ts',
    TargetContent: 'foo',
    ReplacementContent: 'bar',
  }, context);

  // Error must NOT be TOOL_NOT_ALLOWED_THIS_TURN
  assert.notEqual(res.result.errorCode, 'TOOL_NOT_ALLOWED_THIS_TURN');
});

test('CognitiveHarness synchronizes scaffolding instructions strictly by phase to prevent unauthorized tool attempts', () => {
  const harness = new CognitiveHarness();

  // 1. In PLAN phase: code mutations are strictly forbidden in negativeGate & topology
  const planScaffold = harness.createScaffold({
    request: 'Sửa lỗi null pointer trong auth.ts và cập nhật cấu hình',
    phase: 'plan',
    activeTask: 'Lập kế hoạch sửa auth',
  });
  assert.equal(planScaffold.category, 'code');
  assert.equal(planScaffold.phase, 'plan');
  assert.ok(planScaffold.negativeGate.some(g => g.includes('PHASE LOCK: PLAN')));
  assert.ok(planScaffold.negativeGate.some(g => g.includes('replace_text')));
  // Topology must NOT guide LLM to call replace_text / apply_patch during PLAN phase
  assert.equal(planScaffold.executionTopology.some(s => s.includes('replace_text')), false);
  assert.ok(planScaffold.executionTopology.some(s => s.includes('create_plan')));
  assert.ok(planScaffold.actionBoundary.includes('FORBIDDEN'));

  const planPrompt = harness.formatScaffoldForPrompt(planScaffold);
  assert.ok(planPrompt.includes('PHASE GOVERNANCE]: PLAN MODE (advisory)'));
  const planCompact = harness.formatScaffoldForCompactPrompt(planScaffold);
  assert.ok(planCompact.includes('PLAN MODE (advisory)'));

  // 2. In EXPLORE phase: mutations locked, guides empirical inspection
  const exploreScaffold = harness.createScaffold({
    request: 'fix error in token validation',
    phase: 'explore',
  });
  assert.equal(exploreScaffold.phase, 'explore');
  assert.ok(exploreScaffold.negativeGate.some(g => g.includes('PHASE LOCK: EXPLORE')));
  assert.equal(exploreScaffold.executionTopology.some(s => s.includes('replace_text')), false);
  const exploreCompact = harness.formatScaffoldForCompactPrompt(exploreScaffold);
  assert.ok(exploreCompact.includes('EXPLORE MODE (advisory)'));

  // 3. In VERIFY phase: lock new features, test execution active
  const verifyScaffold = harness.createScaffold({
    request: 'fix error in token validation',
    phase: 'verify',
  });
  assert.equal(verifyScaffold.phase, 'verify');
  assert.ok(verifyScaffold.negativeGate.some(g => g.includes('PHASE LOCK: VERIFY')));
  const verifyCompact = harness.formatScaffoldForCompactPrompt(verifyScaffold);
  assert.ok(verifyCompact.includes('VERIFY MODE - Test execution active'));

  // 4. In IMPLEMENT phase: surgical implementation is active and unlocked
  const implementScaffold = harness.createScaffold({
    request: 'fix error in token validation',
    phase: 'implement',
  });
  assert.equal(implementScaffold.phase, 'implement');
  assert.ok(implementScaffold.executionTopology.some(s => s.includes('replace_text')));
});

test('Phase governance banners are advisory: no lock/disable/forbid claims', () => {
  const harness = new CognitiveHarness();
  for (const phase of ['plan', 'explore', 'verify'] as const) {
    const scaffold = harness.createScaffold({ request: 'fix error in token validation', phase });
    const full = harness.formatScaffoldForPrompt(scaffold);
    const compact = harness.formatScaffoldForCompactPrompt(scaffold);
    for (const text of [full, compact]) {
      assert.ok(!text.includes('STRICTLY FORBIDDEN'), phase);
      assert.ok(!text.includes('Mutations locked'), phase);
      assert.ok(!text.includes('are DISABLED'), phase);
      assert.ok(!text.includes('are LOCKED'), phase);
    }
  }
});

test('create_file and edit tools are authorized in all phases including plan/explore and implement', () => {
  const registry = new ToolRegistry(new PlanManager());
  const gate = new ThisTurnToolGate();
  const engine = new ClassificationEngine();

  // 1. Task classified with R0 in plan phase
  const planClassification: any = {
    id: 'class-test-plan-r0',
    taskClass: 'feature',
    phase: 'plan',
    complexity: 'large',
    risk: 'R0',
    requiredCapabilities: ['inspect', 'search', 'plan', 'memory'],
    reversibility: 'read-only',
  };

  const planDecision = gate.decide(planClassification, registry.getAll());
  assert.ok(planDecision.allowedToolNames.includes('create_file'), 'create_file is authorized in plan phase');
  assert.ok(planDecision.allowedToolNames.includes('replace_text'), 'replace_text is authorized in plan phase');
  assert.ok(planDecision.allowedToolNames.includes('write_file'), 'write_file is authorized in plan phase');
  assert.ok(planDecision.allowedToolNames.includes('request_phase_transition'), 'request_phase_transition must be allowed in plan phase');

  // 2. Transition accepted to implement
  const session = new Session();
  session.append('turn/start', { turn: 1 });
  session.append('control/decision', { turn: 1, controlDecision: { classification: planClassification } });

  const transition = requestPhaseTransition(session, 1, planClassification, {
    targetPhase: 'implement',
    rationale: 'planning complete, ready to scaffold files',
    evidenceRefs: ['index.html'],
  }, { hasPlan: true, evidenceSufficient: true });
  assert.equal(transition.accepted, true);

  const implementClassification = applyPhaseAuthority(planClassification, session, 1);
  assert.equal(implementClassification.phase, 'implement');
  assert.equal(implementClassification.risk, 'R1');
  assert.equal(implementClassification.reversibility, 'reversible');

  const implementDecision = gate.decide(implementClassification, registry.getAll());
  assert.ok(implementDecision.allowedToolNames.includes('create_file'), 'create_file MUST be authorized in implement phase');
  assert.ok(implementDecision.allowedToolNames.includes('write_file'), 'write_file MUST be authorized in implement phase');
  assert.ok(implementDecision.allowedToolNames.includes('replace_text'), 'replace_text MUST be authorized in implement phase');
  assert.ok(implementDecision.allowedToolNames.includes('apply_patch'), 'apply_patch MUST be authorized in implement phase');

  // 3. Vietnamese coding prompts classified into feature/implement
  const vietPrompt1 = engine.classify({ request: 'Viết code cho index.html' });
  assert.equal(vietPrompt1.taskClass, 'feature');
  assert.ok(vietPrompt1.requiredCapabilities.includes('edit'));

  const vietPrompt2 = engine.classify({ request: 'Hãy lập trình ứng dụng calculator' });
  assert.equal(vietPrompt2.taskClass, 'feature');
  assert.ok(vietPrompt2.requiredCapabilities.includes('edit'));
});

test('Hybrid Multilingual Architecture: Supports English, Vietnamese, French, Japanese, Spanish across the complete transition lifecycle', () => {
  const registry = new ToolRegistry(new PlanManager());
  const gate = new ThisTurnToolGate();
  const engine = new ClassificationEngine();

  const multilingualPrompts = [
    { lang: 'English', prompt: 'Create a new database connector in src/db.ts' },
    { lang: 'Vietnamese', prompt: 'Tạo tệp cấu hình server trong config/app.json' },
    { lang: 'French', prompt: 'Créer un fichier de routage pour les utilisateurs' },
    { lang: 'Japanese', prompt: 'src/index.htmlを作成して初期コードを記述してください' },
    { lang: 'Spanish', prompt: 'Crear una función para procesar pagos en checkout.ts' },
    { lang: 'German', prompt: 'Erstelle eine neue Komponente für das Benutzerprofil' },
  ];

  for (const { lang, prompt } of multilingualPrompts) {
    // 1. Initial classification is a valid coding task
    const classification = engine.classify({ request: prompt });
    assert.ok(
      classification.taskClass === 'feature' || classification.taskClass === 'bugfix',
      `[${lang}] must be recognized as coding taskClass, got: ${classification.taskClass}`
    );

    const initialDecision = gate.decide(classification, registry.getAll());
    assert.ok(initialDecision.allowedToolNames.includes('read_file'), `[${lang}] must allow read_file`);
    assert.ok(initialDecision.allowedToolNames.includes('search_text'), `[${lang}] must allow search_text`);
    
    // In all phases, edit tools are authorized and transition is available
    if (classification.phase === 'explore' || classification.phase === 'plan') {
      assert.ok(initialDecision.allowedToolNames.includes('request_phase_transition'), `[${lang}] must expose request_phase_transition`);
      assert.ok(initialDecision.allowedToolNames.includes('create_file'), `[${lang}] must expose create_file in ${classification.phase}`);
      assert.ok(initialDecision.allowedToolNames.includes('replace_text'), `[${lang}] must expose replace_text in ${classification.phase}`);

      // 2. Perform phase transition to implement with evidence
      const session = new Session();
      session.append('turn/start', { turn: 1 });
      session.append('control/decision', { turn: 1, controlDecision: { classification } });

      const transition = requestPhaseTransition(session, 1, classification, {
        targetPhase: 'implement',
        rationale: `Gathered workspace context for ${lang} prompt, ready to scaffold`,
        evidenceRefs: ['workspace-root', 'tool-result:read-1'],
      }, { hasPlan: true, evidenceSufficient: true });

      assert.equal(transition.accepted, true, `[${lang}] phase transition to implement must be accepted`);

      // 3. Authority is elevated to implement
      const implementClassification = applyPhaseAuthority(classification, session, 1);
      assert.equal(implementClassification.phase, 'implement');
      assert.ok(implementClassification.risk !== 'R0', `[${lang}] risk floor must be elevated to R1+`);

      const implementDecision = gate.decide(implementClassification, registry.getAll());
      assert.ok(implementDecision.allowedToolNames.includes('create_file'), `[${lang}] MUST authorize create_file in implement`);
      assert.ok(implementDecision.allowedToolNames.includes('write_file'), `[${lang}] MUST authorize write_file in implement`);
      assert.ok(implementDecision.allowedToolNames.includes('replace_text'), `[${lang}] MUST authorize replace_text in implement`);
    } else {
      // Direct fastPath implement
      assert.ok(initialDecision.allowedToolNames.includes('create_file'), `[${lang}] fast-path MUST authorize create_file`);
    }
  }
});

test('replace_text and edit tools remain authorized in implement phase across multi-step mutations', () => {
  const gate = new ThisTurnToolGate();
  const registry = new ToolRegistry();
  registerSubmitSolutionTool(registry, new Workspace());
  const session = new Session();
  session.append('turn/start', { turn: 1 });

  const initialClassification: any = {
    id: 'class-test-multi-edit',
    taskClass: 'feature',
    phase: 'implement',
    complexity: 'medium',
    risk: 'R2',
    requiredCapabilities: ['inspect', 'search', 'plan', 'memory', 'edit', 'execute', 'verify', 'git-read', 'complete'],
    reversibility: 'reversible',
  };
  session.append('control/decision', { turn: 1, controlDecision: { classification: initialClassification } });

  const authority = applyPhaseAuthority(initialClassification, session, 1);
  const decision = gate.decide(authority, registry.getAll());

  assert.equal(authority.phase, 'implement');
  assert.ok(decision.allowedToolNames.includes('replace_text'), 'replace_text must be authorized in implement');
  assert.ok(decision.allowedToolNames.includes('create_file'), 'create_file must be authorized in implement');
  assert.ok(decision.allowedToolNames.includes('write_file'), 'write_file must be authorized in implement');
  assert.ok(decision.allowedToolNames.includes('submit_solution'), 'submit_solution must be authorized in implement');
});

test('EDIT and CREATE tools are authorized in ALL phases across all MINUS_TOOL_CONTROL_MODEs', async () => {
  const gate = new ThisTurnToolGate();
  const registry = new ToolRegistry();
  const workspace = new Workspace(process.cwd());

  const editAndCreateTools = [
    'replace_text',
    'create_file',
    'write_file',
    'apply_patch',
    'delete_file',
    'move_file',
    'write_to_file',
    'replace_file_content',
    'multi_replace_file_content',
  ];

  const phases = ['explore', 'plan', 'implement', 'verify', 'release'] as const;

  for (const phase of phases) {
    const classification: any = {
      id: `class-test-${phase}`,
      taskClass: 'exploration',
      phase,
      complexity: 'small',
      risk: 'R0',
      requiredCapabilities: ['inspect', 'search'],
      reversibility: 'read-only',
    };

    const decision = gate.decide(classification, registry.getAll());
    for (const toolName of editAndCreateTools) {
      assert.ok(
        decision.allowedToolNames.includes(toolName),
        `Tool "${toolName}" must be authorized in phase "${phase}" by ThisTurnToolGate`,
      );
    }

    // Verify ToolRunner execution across all 3 modes (off, shadow, enforce)
    const runner = new ToolRunner(registry, workspace);
    const context: any = {
      decisionId: decision.id,
      allowedToolNames: decision.allowedToolNames,
      allowedToolSetHash: decision.allowedToolSetHash,
      classificationPhase: phase,
      turn: 1,
    };

    for (const controlMode of ['off', 'shadow', 'enforce'] as const) {
      // Test with replace_text (mock or real args)
      const res = await runner.run('replace_text', {
        filePath: 'non_existent_anchor_test.ts',
        oldText: 'a',
        newText: 'b',
      }, { ...context, controlMode });

      // Must NOT be blocked by TOOL_NOT_ALLOWED_THIS_TURN
      assert.notEqual(
        res.result?.errorCode,
        'TOOL_NOT_ALLOWED_THIS_TURN',
        `replace_text must NOT be rejected with TOOL_NOT_ALLOWED_THIS_TURN in phase "${phase}" under controlMode "${controlMode}"`,
      );
    }
  }
});

test('implement → plan return is exposed, accepted before mutations and blocked after', () => {
  const registry = new ToolRegistry(new PlanManager());
  const gate = new ThisTurnToolGate();
  const implementClassification: any = {
    id: 'class-test-return-plan',
    taskClass: 'feature',
    phase: 'implement',
    complexity: 'medium',
    risk: 'R1',
    requiredCapabilities: ['inspect', 'search', 'plan', 'edit', 'execute', 'verify', 'git-read', 'complete', 'memory'],
    reversibility: 'reversible',
  };

  // 1. Gate exposes the transition tool in implement so the model can ask to go back.
  const implementDecision = gate.decide(implementClassification, registry.getAll());
  assert.ok(implementDecision.allowedToolNames.includes('request_phase_transition'), 'request_phase_transition must be exposed in implement phase');

  // 2. Accepted when nothing has been mutated yet this turn.
  const session = new Session();
  session.append('turn/start', { turn: 1 });
  session.append('control/decision', { turn: 1, controlDecision: { classification: implementClassification } });
  const back = requestPhaseTransition(session, 1, implementClassification, {
    targetPhase: 'plan',
    rationale: 'scope is larger than understood, need milestones before editing',
    evidenceRefs: ['src/index.ts'],
  }, { hasPlan: false, evidenceSufficient: true });
  assert.equal(back.accepted, true);
  assert.equal(back.phase, 'plan');
  assert.equal(applyPhaseAuthority(implementClassification, session, 1).phase, 'plan');

  // 3. Round trip plan → implement still works afterwards.
  const fwd = requestPhaseTransition(session, 1, { ...implementClassification, phase: 'plan' }, {
    targetPhase: 'implement',
    rationale: 'plan finalized',
    evidenceRefs: ['plan-task-1'],
  }, { hasPlan: true, evidenceSufficient: true });
  assert.equal(fwd.accepted, true);

  // 4. Blocked once a mutation is observed; guidance points at verify.
  session.append('tool/call', { turn: 1, toolName: 'replace_text', args: { path: 'a.ts' }, toolCallId: 'call-1' });
  session.append('tool/result', { turn: 1, toolName: 'replace_text', toolCallId: 'call-1', result: { filesModified: ['a.ts'] } });
  const blocked = requestPhaseTransition(session, 1, implementClassification, {
    targetPhase: 'plan',
    rationale: 'want to replan',
    evidenceRefs: ['a.ts'],
  }, { hasPlan: false, evidenceSufficient: true });
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.errorCode, 'IMPLEMENT_MUTATIONS_PRESENT');
  assert.match(getPhaseTransitionRecoveryGuidance(blocked.errorCode, blocked.reason), /verify/i);

  // 5. A repeated implement → plan → implement → plan loop with identical
  // rationale+evidence is rejected as a duplicate; new evidence still passes.
  const loopSession = new Session();
  loopSession.append('turn/start', { turn: 2 });
  loopSession.append('control/decision', { turn: 2, controlDecision: { classification: implementClassification } });
  const first = requestPhaseTransition(loopSession, 2, implementClassification, {
    targetPhase: 'plan',
    rationale: 'need milestones',
    evidenceRefs: ['src/index.ts'],
  }, { hasPlan: false, evidenceSufficient: true });
  assert.equal(first.accepted, true);
  const fwd2 = requestPhaseTransition(loopSession, 2, { ...implementClassification, phase: 'plan' }, {
    targetPhase: 'implement',
    rationale: 'plan drafted',
    evidenceRefs: ['plan-task-1'],
  }, { hasPlan: true, evidenceSufficient: true });
  assert.equal(fwd2.accepted, true);
  const loop = requestPhaseTransition(loopSession, 2, implementClassification, {
    targetPhase: 'plan',
    rationale: 'need milestones',
    evidenceRefs: ['src/index.ts'],
  }, { hasPlan: false, evidenceSufficient: true });
  assert.equal(loop.accepted, false);
  assert.equal(loop.errorCode, 'DUPLICATE_TRANSITION_REQUEST');
  const retry = requestPhaseTransition(loopSession, 2, implementClassification, {
    targetPhase: 'plan',
    rationale: 'need milestones',
    evidenceRefs: ['src/index.ts', 'tool-result:read-2'],
  }, { hasPlan: false, evidenceSufficient: true });
  assert.equal(retry.accepted, true);
});

test('plan → explore step-back is accepted with evidence', () => {
  const planClassification: any = {
    id: 'class-test-plan-back-explore',
    taskClass: 'feature',
    phase: 'plan',
    complexity: 'medium',
    risk: 'R1',
    requiredCapabilities: ['inspect', 'search', 'plan', 'memory'],
    reversibility: 'read-only',
  };
  const session = new Session();
  session.append('turn/start', { turn: 1 });
  session.append('control/decision', { turn: 1, controlDecision: { classification: planClassification } });
  const back = requestPhaseTransition(session, 1, planClassification, {
    targetPhase: 'explore',
    rationale: 'need to inspect an uncovered dependency before planning',
    evidenceRefs: ['src/index.ts'],
  }, { hasPlan: false, evidenceSufficient: true });
  assert.equal(back.accepted, true);
  assert.equal(back.phase, 'explore');
  assert.equal(applyPhaseAuthority(planClassification, session, 1).phase, 'explore');
});

test('phase directive never advertises a transition the harness would deny', () => {
  const planBlocked = buildPhaseToolAuthorityDirective('plan', ['create_plan', 'read_file'], { canRequestPhaseTransition: false });
  assert.doesNotMatch(planBlocked, /request_phase_transition/);
  assert.match(planBlocked, /create_plan/);
  const planAllowed = buildPhaseToolAuthorityDirective('plan', ['create_plan', 'request_phase_transition'], { canRequestPhaseTransition: true });
  assert.match(planAllowed, /request_phase_transition/);
});
