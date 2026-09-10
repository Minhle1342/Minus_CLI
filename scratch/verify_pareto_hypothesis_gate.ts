/**
 * Independent verification script for Pareto 80/20 Active Hypothesis Tool & Pre-Mutation Gate.
 * 
 * Verifies:
 * 1. Tool registration & descriptors (formulate_and_verify_hypothesis, EDIT set completeness).
 * 2. Strict input validation of formulate_and_verify_hypothesis.
 * 3. ClassificationEngine explore-first rule & ThisTurnToolGate tool filtering.
 * 4. ToolUseGuardian defense-in-depth preCallValidate blocking unverified mutations.
 * 5. Unlock sequence: Once a hypothesis is verified, Implement phase unlocks for surgical edits.
 */

import assert from 'node:assert';
import { ToolRegistry } from '../src/tools/registry.js';
import { HypothesisTracker } from '../src/agent/hypothesis-tracker.js';
import { createHypothesisTool } from '../src/tools/hypothesis-tool.js';
import { ToolDescriptorRegistry, TOOL_SETS } from '../src/control/tool-descriptor-registry.js';
import { ClassificationEngine } from '../src/control/classification-engine.js';
import { ThisTurnToolGate } from '../src/control/this-turn-tool-gate.js';
import { ToolUseGuardian } from '../src/tools/tool-use-guardian.js';

async function runVerification() {
  console.log('🚀 [PARETO 80/20 VERIFICATION] Starting comprehensive tests...\n');

  // =========================================================================
  // Test 1: Tool Registration & Descriptors
  // =========================================================================
  console.log('--- Test 1: Tool Registration & Descriptors ---');
  const registry = new ToolRegistry();
  const tracker = new HypothesisTracker();
  registry.attachHypothesisTracker(tracker);

  const hypothesisTool = registry.get('formulate_and_verify_hypothesis');
  assert(hypothesisTool, 'Tool formulate_and_verify_hypothesis must be registered in ToolRegistry');
  console.log('✔ Tool formulate_and_verify_hypothesis is registered in ToolRegistry');

  const descriptorRegistry = new ToolDescriptorRegistry();
  const descriptor = descriptorRegistry.describe(hypothesisTool);
  assert(descriptor, 'Descriptor must exist for formulate_and_verify_hypothesis');
  assert.strictEqual(descriptor.minimumRisk, 'R0', 'Descriptor risk must be R0');
  assert(descriptor.phases.includes('explore'), 'Phases must include explore');
  assert(descriptor.phases.includes('plan'), 'Phases must include plan');
  assert(descriptor.capabilities.includes('verify'), 'Capabilities must include verify');
  console.log('✔ Tool descriptor properly configured with R0, explore/plan phases, and verify capability');

  // Verify EDIT set has both new and legacy mutation tools
  const editTools = TOOL_SETS.EDIT;
  const expectedEditTools = [
    'write_to_file',
    'replace_file_content',
    'multi_replace_file_content',
    'create_file',
    'delete_file',
    'replace_text',
    'apply_patch',
  ];
  for (const tool of expectedEditTools) {
    assert(editTools.has(tool), `TOOL_SETS.EDIT must contain ${tool}`);
  }
  console.log(`✔ TOOL_SETS.EDIT contains all ${expectedEditTools.length} workspace mutation tools`);

  // =========================================================================
  // Test 2: Input Validation of formulate_and_verify_hypothesis
  // =========================================================================
  console.log('\n--- Test 2: Input Validation for formulate_and_verify_hypothesis ---');

  // Short statement
  const invalid1: any = await hypothesisTool.execute({
    statement: 'Too short',
    falsificationTest: 'This is a valid falsification test description',
    targetFiles: ['src/agent/agent-loop.ts'],
    evidence: 'Evidence found in line 45 where function is called with null',
  });
  assert.strictEqual(invalid1.success, false, 'Must reject short statement');
  assert.strictEqual(invalid1.errorCode, 'INSUFFICIENT_HYPOTHESIS_STATEMENT');
  console.log('✔ Rejected too short statement (<30 chars)');

  // Short falsification test
  const invalid2: any = await hypothesisTool.execute({
    statement: 'The cache key in AgentLoop causes token calculation mismatch due to undefined prompt',
    falsificationTest: 'Short test',
    targetFiles: ['src/agent/agent-loop.ts'],
    evidence: 'Evidence found in line 45 where function is called with null',
  });
  assert.strictEqual(invalid2.success, false, 'Must reject short falsification test');
  assert.strictEqual(invalid2.errorCode, 'INSUFFICIENT_FALSIFICATION_CRITERIA');
  console.log('✔ Rejected too short falsification test (<20 chars)');

  // Empty target files
  const invalid3: any = await hypothesisTool.execute({
    statement: 'The cache key in AgentLoop causes token calculation mismatch due to undefined prompt',
    falsificationTest: 'This is a valid falsification test description',
    targetFiles: [],
    evidence: 'Evidence found in line 45 where function is called with null',
  });
  assert.strictEqual(invalid3.success, false, 'Must reject empty targetFiles');
  assert.strictEqual(invalid3.errorCode, 'MISSING_TARGET_FILES');
  console.log('✔ Rejected empty targetFiles');

  // Valid hypothesis creation & validation without command
  const validResult: any = await hypothesisTool.execute({
    statement: 'The cache key in AgentLoop causes token calculation mismatch due to undefined prompt',
    falsificationTest: 'If prompt is strictly defined, token mismatch drops to zero in unit test',
    targetFiles: ['src/agent/agent-loop.ts'],
    evidence: 'Inspected src/agent/agent-loop.ts lines 120-135: prompt variable is accessed before default assignment',
  });
  assert.strictEqual(validResult.success, true, 'Valid hypothesis must succeed');
  assert.strictEqual(validResult.status, 'validated', 'Status must be validated');
  assert.strictEqual(validResult.canProceedToImplement, true, 'Can proceed to implement must be true');
  assert(validResult.guidance?.includes('PRE-MUTATION GATE UNLOCKED'), 'Gate unlock message must be displayed');
  console.log('✔ Valid hypothesis successfully formulated and validated');
  assert.strictEqual(tracker.getStats().validatedCount, 1, 'Tracker must show 1 validated hypothesis');
  console.log('✔ HypothesisTracker recorded 1 validated hypothesis');

  // =========================================================================
  // Test 3: ClassificationEngine Explore-First Rule & ThisTurnToolGate
  // =========================================================================
  console.log('\n--- Test 3: ClassificationEngine Explore-First Rule & ThisTurnToolGate ---');
  const classificationEngine = new ClassificationEngine();
  const toolGate = new ThisTurnToolGate();

  // Scenario A: Bugfix task with NO validated hypothesis
  const classA = classificationEngine.classify({
    userPrompt: 'Fix the bug where agent loop crashes on undefined token',
    intent: 'bugfix',
    turnIndex: 0,
    hasValidatedHypothesis: false,
  });
  assert.strictEqual(classA.phase, 'explore', 'Bugfix without validated hypothesis MUST be locked in explore phase');
  assert(!classA.requiredCapabilities.includes('edit'), 'Explore phase MUST NOT include edit capability');
  console.log('✔ Unverified bugfix is locked to phase: explore (edit capability withheld)');

  // Gate hides mutation tools in Explore phase
  const allToolDecls = [
    { name: 'read_file', description: 'read' },
    { name: 'inspect_symbol', description: 'inspect' },
    { name: 'formulate_and_verify_hypothesis', description: 'hypothesis' },
    { name: 'write_to_file', description: 'write' },
    { name: 'replace_file_content', description: 'replace' },
    { name: 'apply_patch', description: 'patch' },
  ];
  const gatedDecisionA = toolGate.decide(classA, allToolDecls as any);
  assert(!gatedDecisionA.allowedToolNames.includes('write_to_file'), 'write_to_file must be hidden in explore phase');
  assert(!gatedDecisionA.allowedToolNames.includes('replace_file_content'), 'replace_file_content must be hidden in explore phase');
  assert(!gatedDecisionA.allowedToolNames.includes('apply_patch'), 'apply_patch must be hidden in explore phase');
  assert(gatedDecisionA.allowedToolNames.includes('formulate_and_verify_hypothesis'), 'formulate_and_verify_hypothesis must be available');
  console.log('✔ ThisTurnToolGate successfully hides mutation tools and exposes hypothesis tool');

  // =========================================================================
  // Test 4: ToolUseGuardian Pre-Mutation Defense-in-Depth
  // =========================================================================
  console.log('\n--- Test 4: ToolUseGuardian Pre-Mutation Defense-in-Depth ---');
  const guardian = new ToolUseGuardian();

  // When pre-mutation gate is active and hypothesis is NOT validated
  guardian.setPreMutationGateContext({
    taskIntent: 'bugfix',
    hasValidatedHypothesis: false,
    hypothesisCount: 0,
  });

  const block1 = guardian.preCallValidate('write_to_file', {
    TargetFile: 'd:/AgentLearn/CodingAgent/src/agent/agent-loop.ts',
    CodeContent: 'console.log("hacked")',
  });
  assert(!block1.allowed, 'write_to_file must be blocked when hypothesis is unverified');
  assert(block1.reason?.includes('UNVERIFIED_MUTATION_BLOCKED'), 'Reason must be UNVERIFIED_MUTATION_BLOCKED');
  console.log('✔ ToolUseGuardian blocked write_to_file with UNVERIFIED_MUTATION_BLOCKED');

  const block2 = guardian.preCallValidate('replace_file_content', {
    TargetFile: 'd:/AgentLearn/CodingAgent/src/agent/agent-loop.ts',
    TargetContent: 'foo',
    ReplacementContent: 'bar',
  });
  assert(!block2.allowed, 'replace_file_content must be blocked');
  assert(block2.reason?.includes('formulate_and_verify_hypothesis'), 'Must recommend formulate_and_verify_hypothesis');
  console.log('✔ ToolUseGuardian blocked replace_file_content with actionable recommendation');

  // Read/Inspect tools should still be allowed
  const allowInspect = guardian.preCallValidate('read_file', { filePath: 'src/agent/agent-loop.ts' });
  assert(allowInspect.allowed, 'read_file must always be allowed');
  console.log('✔ ToolUseGuardian allows non-mutation tools during Explore phase');

  // =========================================================================
  // Test 5: Unlock Phase Implement After Hypothesis Validation
  // =========================================================================
  console.log('\n--- Test 5: Unlock Phase Implement After Hypothesis Validation ---');

  // Once validated hypothesis exists:
  const classB = classificationEngine.classify({
    userPrompt: 'Fix the bug where agent loop crashes on undefined token',
    intent: 'bugfix',
    turnIndex: 2,
    hasValidatedHypothesis: true,
  });
  assert.strictEqual(classB.phase, 'implement', 'Phase must advance to implement when hypothesis is validated');
  assert(classB.requiredCapabilities.includes('edit'), 'Implement phase must include edit capability');
  console.log('✔ ClassificationEngine unlocked phase: implement with edit capability');

  const gatedDecisionB = toolGate.decide(classB, allToolDecls as any);
  assert(gatedDecisionB.allowedToolNames.includes('write_to_file'), 'write_to_file must now be visible in implement phase');
  assert(gatedDecisionB.allowedToolNames.includes('replace_file_content'), 'replace_file_content must now be visible in implement phase');
  console.log('✔ ThisTurnToolGate revealed mutation tools for surgical edits');

  // Guardian allows mutation once preMutationGateContext has hasValidatedHypothesis: true
  guardian.setPreMutationGateContext({
    taskIntent: 'bugfix',
    hasValidatedHypothesis: true,
    hypothesisCount: 1,
  });
  const allowMutation = guardian.preCallValidate('replace_file_content', {
    TargetFile: 'd:/AgentLearn/CodingAgent/src/agent/agent-loop.ts',
    TargetContent: 'foo',
    ReplacementContent: 'bar',
  });
  assert(allowMutation.allowed, 'Mutation must be permitted after hypothesis validation');
  console.log('✔ ToolUseGuardian permitted mutation after hypothesis validation');

  console.log('\n🎉 [PARETO 80/20 VERIFICATION] All 5 test suites passed with 100% success!');
}

runVerification().catch((err) => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
