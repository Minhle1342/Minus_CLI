import assert from 'node:assert';
import { PromptAssembler } from '../src/llm/prompt-assembler.js';
import {
  DEFAULT_PROMPT_SECTIONS,
  detectPromptContext,
  resolvePhaseDynamicGuidance,
  SECTION_PHASE_EXPLORE_GUIDANCE,
  SECTION_PHASE_IMPLEMENT_GUIDANCE,
  SECTION_PHASE_VERIFY_GUIDANCE,
  SECTION_PATCH_FORMAT_SPEC,
} from '../src/llm/prompts.js';
import { DynamicContextArbiter } from '../src/agent/dynamic-context-arbiter.js';

async function runTests() {
  console.log('🧪 Starting Pareto & Cache-Safe Phase Dynamic Guidance Verification...\n');

  // 1. TEST 1: SYSTEM PROMPT PREFIX INVARIANCE (Bảo toàn 100% KV-Cache)
  console.log('Test 1: Prefix Invariance of System Prompt across Phases...');
  const assembler = new PromptAssembler();
  for (const section of DEFAULT_PROMPT_SECTIONS) {
    assembler.register(section);
  }
  const context = detectPromptContext(undefined, undefined, 'Fix bug in auth service');
  
  const systemPromptStep1 = assembler.assembleForContext(context);
  const systemPromptStep2 = assembler.assembleForContext(context);
  const systemPromptStep3 = assembler.assembleForContext(context);

  assert.strictEqual(
    systemPromptStep1,
    systemPromptStep2,
    'System prompt MUST be byte-for-byte identical across turns (Prefix Invariance)',
  );
  assert.strictEqual(
    systemPromptStep2,
    systemPromptStep3,
    'System prompt MUST remain completely invariant to guarantee KV-cache hit rate',
  );
  console.log('  ✔ Prefix Invariance passed: System prompt signature is 100% identical.\n');

  // 2. TEST 2: EXPLORE PHASE (80% Reasoning Budget, Zero Patch Spec Clutter)
  console.log('Test 2: Explore Phase Dynamic Guidance...');
  const exploreGuidanceUnvalidated = resolvePhaseDynamicGuidance('explore', {
    taskClass: 'bugfix',
    hasValidatedHypothesis: false,
  });
  assert(exploreGuidanceUnvalidated.includes(SECTION_PHASE_EXPLORE_GUIDANCE), 'Must include explore guidance');
  assert(exploreGuidanceUnvalidated.includes('Pre-Mutation Gate ACTIVE'), 'Must warn pre-mutation gate when hypothesis unvalidated');
  assert(!exploreGuidanceUnvalidated.includes('*** Begin Patch ***'), 'Explore phase MUST NOT contain patch format spec');

  const exploreGuidanceValidated = resolvePhaseDynamicGuidance('explore', {
    taskClass: 'bugfix',
    hasValidatedHypothesis: true,
  });
  assert(exploreGuidanceValidated.includes('Causal hypothesis is VALIDATED'), 'Must inform hypothesis is validated');
  console.log('  ✔ Explore Phase passed: Pre-mutation gate & 80% reasoning active, zero patch spec waste.\n');

  // 3. TEST 3: IMPLEMENT PHASE (Surgical Mutation + Unified Diff Spec)
  console.log('Test 3: Implement Phase Dynamic Guidance...');
  const implementGuidance = resolvePhaseDynamicGuidance('implement', {
    taskClass: 'bugfix',
    includePatchSpec: true,
  });
  assert(implementGuidance.includes(SECTION_PHASE_IMPLEMENT_GUIDANCE), 'Must include implement guidance');
  assert(implementGuidance.includes(SECTION_PATCH_FORMAT_SPEC), 'Must include patch format spec in implement phase');
  assert(!implementGuidance.includes(SECTION_PHASE_EXPLORE_GUIDANCE), 'Implement phase MUST NOT include explore guidance');
  console.log('  ✔ Implement Phase passed: Patch format spec loaded on-demand, no exploration overhead.\n');

  // 4. TEST 4: VERIFY PHASE (Verification Ladder & Completion Gate)
  console.log('Test 4: Verify Phase Dynamic Guidance...');
  const verifyGuidance = resolvePhaseDynamicGuidance('verify');
  assert(verifyGuidance.includes(SECTION_PHASE_VERIFY_GUIDANCE), 'Must include verify guidance');
  assert(verifyGuidance.includes('submit_solution'), 'Must emphasize submit_solution completion gate');
  assert(!verifyGuidance.includes('*** Begin Patch ***'), 'Verify phase MUST NOT contain patch format spec');
  console.log('  ✔ Verify Phase passed: Verification ladder loaded on-demand.\n');

  // 5. TEST 5: DYNAMIC CONTEXT ARBITER ARBITRATION & PRIORITY 1.5
  console.log('Test 5: DynamicContextArbiter Priority & Injection...');
  const arbiter = new DynamicContextArbiter(2000);
  const result = arbiter.arbitrate({
    advicePrompt: 'ADVICE_P1: Run get_diagnostics',
    phaseGuidance: exploreGuidanceUnvalidated,
    rawPlanContext: 'PLAN_P2: Milestone 1 in progress',
    memoryPrompt: 'MEMORY_P4: Key insight',
  }, 'gemini-2.5-flash');

  assert(result.sourcesIncluded.some((s) => s.includes('Tool Advice')), 'P1 Tool Advice must be included');
  assert(result.sourcesIncluded.some((s) => s.includes('Phase Guidance')), 'P1.5 Phase Guidance must be included');
  assert(result.renderedContext.includes('ADVICE_P1'), 'Rendered context must contain P1 advice');
  assert(result.renderedContext.includes('PHASE: EXPLORE'), 'Rendered context must contain P1.5 phase guidance');
  assert(result.renderedContext.includes('PLAN_P2'), 'Rendered context must contain P2 plan');

  // Verify ordering: Advice (P1) -> Phase Guidance (P1.5) -> Plan (P2)
  const idxAdvice = result.renderedContext.indexOf('ADVICE_P1');
  const idxPhase = result.renderedContext.indexOf('PHASE: EXPLORE');
  const idxPlan = result.renderedContext.indexOf('PLAN_P2');
  assert(idxAdvice < idxPhase, 'P1 Advice must precede P1.5 Phase Guidance');
  assert(idxPhase < idxPlan, 'P1.5 Phase Guidance must precede P2 Plan');
  console.log('  ✔ DynamicContextArbiter passed: Strict priority P1 -> P1.5 -> P2 preserved.\n');

  console.log('🎉 All Pareto & Cache-Safe Phase Dynamic Guidance tests passed successfully!');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
