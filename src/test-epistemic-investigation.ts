import assert from 'node:assert/strict';
import { 
  EpistemicInvestigationEngine, 
  EpistemicInvestigationGating, 
  CrossAgentDualInvestigator, 
  TestTimeMonteCarloRollout, 
  EpistemicDistillationBarrier 
} from './agent/epistemic-investigation-engine.js';
import { HypothesisTracker } from './agent/hypothesis-tracker.js';
import { DynamicContextArbiter } from './agent/dynamic-context-arbiter.js';

async function runTests() {
  console.log('--- STARTING EPISTEMIC INVESTIGATION SUITE ---');

  // Test 1: Selective Gating (Anti-Accuracy Degradation & Zero Overhead Bypass)
  console.log('1. Testing EpistemicInvestigationGating...');
  {
    // Low risk, explore phase, 0 failures -> Must BYPASS
    const bypassResult = EpistemicInvestigationGating.shouldActivate({
      phase: 'explore',
      risk: 'LOW',
      consecutiveFailures: 0,
    });
    assert.strictEqual(bypassResult.activate, false, 'Low risk explore must bypass gating');
    assert.match(bypassResult.reason, /Bypassed/);

    // High risk in implement phase -> Must ACTIVATE
    const activateHighRisk = EpistemicInvestigationGating.shouldActivate({
      phase: 'implement',
      risk: 'HIGH',
      consecutiveFailures: 0,
    });
    assert.strictEqual(activateHighRisk.activate, true, 'High risk in implement phase must activate');

    // Consecutive failures >= 2 -> Must ACTIVATE regardless of phase
    const activateFailures = EpistemicInvestigationGating.shouldActivate({
      phase: 'explore',
      risk: 'LOW',
      consecutiveFailures: 2,
    });
    assert.strictEqual(activateFailures.activate, true, 'Consecutive failures >= 2 must activate debiasing');
    console.log('   ✅ Gating correctly passes low-risk and triggers on high-risk/failures');
  }

  // Test 2: Cross-Agent Dual Investigation (Thesis vs Antithesis)
  console.log('2. Testing CrossAgentDualInvestigator...');
  {
    const investigator = new CrossAgentDualInvestigator();
    const verdict = investigator.investigate({
      phase: 'implement',
      risk: 'HIGH',
      consecutiveFailures: 1,
      targetFiles: ['src/core/parser.ts'],
      proposedFixSummary: 'Fix regex backtracking loop',
    });

    assert.ok(verdict.thesisClaim.includes('parser.ts') || verdict.thesisClaim.includes('regex backtracking'), 'Thesis should address proposed fix');
    assert.ok(verdict.antithesisRebuttal.includes('Phản biện'), 'Antithesis rebuttal must provide skeptical critique');
    assert.ok(verdict.epistemicArbiterReasoning.length > 0, 'Arbiter reasoning must be populated');
    assert.ok(verdict.confidence > 0 && verdict.confidence <= 1.0, 'Confidence must be between 0 and 1');
    console.log('   ✅ Dual Investigation produces structured Thesis, Antithesis, and Arbiter verdict');
  }

  // Test 3: Lightweight Test-Time Monte Carlo Rollout (Lookahead Simulation)
  console.log('3. Testing TestTimeMonteCarloRollout...');
  {
    const rollout = new TestTimeMonteCarloRollout();
    const res = rollout.simulateRollout({
      phase: 'implement',
      risk: 'CRITICAL',
      consecutiveFailures: 2,
    });

    assert.strictEqual(res.steps.length, 2, 'Should perform 2 rollout lookahead steps');
    assert.ok(res.meanScore > 0, 'Mean score must be positive');
    assert.strictEqual(res.passedSyntaxCheck, true, 'Syntax check should pass in simulation');
    assert.ok(res.criticalRisksIdentified.length > 0, 'Critical risk should be identified for 2 consecutive failures and CRITICAL risk');
    console.log('   ✅ Monte Carlo Rollout simulates 2-step lookahead and captures critical risks');
  }

  // Test 4: Anti-Context Dilution Distillation Barrier (Budget <= 180 tokens)
  console.log('4. Testing EpistemicDistillationBarrier...');
  {
    const barrier = new EpistemicDistillationBarrier();
    const investigator = new CrossAgentDualInvestigator();
    const rollout = new TestTimeMonteCarloRollout();

    const inputs = {
      phase: 'verify' as const,
      risk: 'HIGH' as const,
      consecutiveFailures: 2,
      proposedFixSummary: 'Major architectural change in memory manager',
    };

    const verdict = investigator.investigate(inputs);
    const simRollout = rollout.simulateRollout(inputs);
    const { distilledText, tokenCount } = barrier.distill(verdict, simRollout);

    assert.ok(tokenCount <= EpistemicDistillationBarrier.MAX_DISTILLED_TOKENS, `Token count (${tokenCount}) must be <= ${EpistemicDistillationBarrier.MAX_DISTILLED_TOKENS}`);
    assert.match(distilledText, /EPISTEMIC ARBITER VERDICT/);
    assert.match(distilledText, /Antithesis Risk Guard/);
    assert.match(distilledText, /Speculative Rollout/);
    console.log(`   ✅ Distillation Barrier successfully constrained context to ${tokenCount} tokens (<= 180 limit)`);
  }

  // Test 5: Full Engine Execution (Bypass vs Active)
  console.log('5. Testing EpistemicInvestigationEngine Facade...');
  {
    const engine = new EpistemicInvestigationEngine();

    // Case A: Low risk bypass
    const bypassed = engine.investigate({
      phase: 'explore',
      risk: 'LOW',
      consecutiveFailures: 0,
    });
    assert.strictEqual(bypassed.activated, false);
    assert.strictEqual(bypassed.tokensUsed, 0);
    assert.strictEqual(bypassed.distilledContext, undefined);

    // Case B: High risk active
    const active = engine.investigate({
      phase: 'implement',
      risk: 'HIGH',
      consecutiveFailures: 0,
      proposedFixSummary: 'Optimize KV-Cache boundary',
    });
    assert.strictEqual(active.activated, true);
    assert.ok(active.tokensUsed > 0 && active.tokensUsed <= 180);
    assert.ok(active.distilledContext);
    console.log('   ✅ Engine correctly yields 0 tokens on bypass, compact verdict on activation');
  }

  // Test 6: Integration with HypothesisTracker
  console.log('6. Testing HypothesisTracker Integration...');
  {
    const tracker = new HypothesisTracker();
    const h = tracker.formulate({
      statement: 'KV Cache boundaries are misaligned on step suffixes',
      falsificationTest: 'npm test test-latency-optimization.ts',
      blastRadius: 'HIGH',
    });

    const engine = new EpistemicInvestigationEngine();
    const result = engine.investigate({
      hypothesis: h,
      phase: 'implement',
      risk: h.blastRadius,
      consecutiveFailures: 0,
    });

    assert.strictEqual(result.activated, true);
    if (result.dialecticalVerdict) {
      tracker.attachEpistemicVerdict(h.id, result.dialecticalVerdict, result.speculativeRollout);
    }

    const scratchpad = tracker.toScratchpad();
    assert.match(scratchpad, /Epistemic Verdict/);
    assert.match(scratchpad, /CONFIRMED_THESIS|REFINED_HYPOTHESIS/);
    console.log('   ✅ HypothesisTracker attaches epistemic verdict and renders debiased scratchpad');
  }

  // Test 7: Integration with DynamicContextArbiter (Priority 1.44)
  console.log('7. Testing DynamicContextArbiter Integration...');
  {
    const arbiter = new DynamicContextArbiter(2000);
    const engine = new EpistemicInvestigationEngine();
    const active = engine.investigate({
      phase: 'implement',
      risk: 'HIGH',
      consecutiveFailures: 0,
      proposedFixSummary: 'Patch parallel tool result stream',
    });

    const result = arbiter.arbitrate({
      advicePrompt: 'Tool advice here',
      epistemicVerdictContext: active.distilledContext,
      hypothesisContext: '🧠 [SYSTEM 2 HYPOTHESIS SCRATCHPAD]: Active H1',
      rawPlanContext: 'Plan Task 1: Complete',
    }, { maxBudgetTokens: 1600 });

    assert.ok(result.sourcesIncluded.includes('Epistemic Arbiter Verdict (P1.44)'), 'Epistemic Arbiter Verdict must be included in arbiter sources');
    assert.ok(result.renderedContext.includes('EPISTEMIC ARBITER VERDICT'), 'Rendered context must contain distilled verdict');
    assert.ok(result.totalTokens <= 1600, 'Total tokens must respect budget');
    console.log('   ✅ DynamicContextArbiter seamlessly includes Epistemic Arbiter Verdict at Priority 1.44');
  }

  console.log('\n🎉 ALL EPISTEMIC INVESTIGATION SUITE TESTS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
