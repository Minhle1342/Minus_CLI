import assert from 'node:assert/strict';
import test from 'node:test';
import { ClassificationEngine } from './classification-engine.js';
import { ThisTurnToolGate } from './this-turn-tool-gate.js';
import { ToolRegistry } from '../tools/registry.js';
import { PlanManager } from '../agent/plan-manager.js';
import { registerSubmitSolutionTool } from '../tools/submit-solution.js';
import { ToolRunner } from '../tools/tool-runner.js';
import { Workspace } from '../workspace/workspace.js';
import { PermissionManager } from '../security/permission-manager.js';
import { CognitiveHarness } from '../agent/cognitive-harness.js';

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

test('phase-based tool scoping includes previously omitted registry tools', () => {
  const registry = new ToolRegistry(new PlanManager());
  registerSubmitSolutionTool(registry, new Workspace(process.cwd()));
  const gate = new ThisTurnToolGate();

  // 1. Explore phase on bugfix
  const exploreClassification: any = {
    id: 'class-test-explore',
    taskClass: 'bugfix',
    phase: 'explore',
    complexity: 'medium',
    risk: 'R2',
    requiredCapabilities: ['inspect', 'search', 'plan', 'execute'],
    reversibility: 'reversible',
  };
  const exploreDecision = gate.decide(exploreClassification, registry.getAll());
  assert.ok(exploreDecision.allowedToolNames.includes('read_file'), 'read_file must be allowed');
  assert.ok(exploreDecision.allowedToolNames.includes('run_node_script'), 'run_node_script must be allowed in explore');
  assert.ok(exploreDecision.allowedToolNames.includes('formulate_and_verify_hypothesis'), 'formulate_and_verify_hypothesis must be allowed');
  assert.ok(exploreDecision.allowedToolNames.includes('web_search'), 'web_search must be allowed in explore');
  assert.equal(exploreDecision.allowedToolNames.includes('replace_text'), false, 'replace_text must NOT be allowed in explore');

  // 2. Implement phase
  const implementClassification: any = {
    id: 'class-test-implement',
    taskClass: 'feature',
    phase: 'implement',
    complexity: 'medium',
    risk: 'R2',
    requiredCapabilities: ['edit', 'inspect', 'execute', 'plan'],
    reversibility: 'reversible',
  };
  const implementDecision = gate.decide(implementClassification, registry.getAll());
  assert.ok(implementDecision.allowedToolNames.includes('replace_text'), 'replace_text must be allowed in implement');
  assert.ok(implementDecision.allowedToolNames.includes('apply_patch'), 'apply_patch must be allowed in implement');
  assert.ok(implementDecision.allowedToolNames.includes('run_node_script'), 'run_node_script must be allowed in implement');
  assert.ok(implementDecision.allowedToolNames.includes('update_plan_task'), 'update_plan_task must be allowed in implement');
  assert.ok(implementDecision.allowedToolNames.includes('web_search'), 'web_search must be allowed in implement');

  // 3. Verify phase
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
  assert.equal(verifyDecision.allowedToolNames.includes('replace_text'), false, 'replace_text must NOT be allowed in verify');
});

test('ClassificationEngine strictly scopes capabilities according to phase and preserves plan on failure', () => {
  const engine = new ClassificationEngine();

  // Bug 1: Large task without plan must be in plan phase WITHOUT 'edit' or 'complete'
  const planClassification = engine.classify({
    request: 'Triển khai toàn bộ kiến trúc hệ thống mới cho module auth',
  });
  assert.equal(planClassification.phase, 'plan');
  assert.equal(planClassification.requiredCapabilities.includes('edit'), false, 'plan phase must NOT have edit capability');
  assert.equal(planClassification.requiredCapabilities.includes('complete'), false, 'plan phase must NOT have complete capability');
  assert.ok(planClassification.requiredCapabilities.includes('plan'), 'plan phase must have plan capability');

  // Bug 2: Failure during plan phase must preserve plan phase and not fall into exploration trap
  const recoveredFromPlan = engine.classify({
    request: 'Triển khai toàn bộ kiến trúc hệ thống mới cho module auth',
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
  assert.ok(planPrompt.includes('PHASE GOVERNANCE]: PLAN MODE ACTIVE'));
  const planCompact = harness.formatScaffoldForCompactPrompt(planScaffold);
  assert.ok(planCompact.includes('PLAN MODE - Tool mutations (replace_text, apply_patch, write_file) are STRICTLY FORBIDDEN'));

  // 2. In EXPLORE phase: mutations locked, guides empirical inspection
  const exploreScaffold = harness.createScaffold({
    request: 'fix error in token validation',
    phase: 'explore',
  });
  assert.equal(exploreScaffold.phase, 'explore');
  assert.ok(exploreScaffold.negativeGate.some(g => g.includes('PHASE LOCK: EXPLORE')));
  assert.equal(exploreScaffold.executionTopology.some(s => s.includes('replace_text')), false);
  const exploreCompact = harness.formatScaffoldForCompactPrompt(exploreScaffold);
  assert.ok(exploreCompact.includes('EXPLORE MODE - Mutations locked'));

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


