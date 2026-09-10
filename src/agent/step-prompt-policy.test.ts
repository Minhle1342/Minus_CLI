import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClassificationDecision } from '../control/classification-types.js';
import { SECTION_TOOL_PLAYBOOKS } from '../llm/prompt-sections.js';
import {
  StepPromptPolicy,
  type StepPromptGatingMode,
  type StepPromptPolicyContext,
} from './step-prompt-policy.js';

const policy = new StepPromptPolicy();

function classification(overrides: Partial<ClassificationDecision> = {}): ClassificationDecision {
  return {
    id: 'classification-test',
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

function context(overrides: Partial<StepPromptPolicyContext> = {}): StepPromptPolicyContext {
  return {
    activeStepQuery: 'Explain the current status',
    fingerprint: 'fp-test',
    classification: classification(),
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
      legacyPlanContext: '[DYNAMIC EXECUTION PLAN]\nNo plan exists.',
      stepPlanContext: '[STEP EXECUTION PLAN]\n1. Active task',
      advicePrompt: '[NEXT ACTION ADVICE]\nGENERAL advice',
      advicePlaybook: 'GENERAL',
      harnessGuidance: '[HARNESS GUIDANCE]',
      scaffoldPrompt: '[COMPACT SCAFFOLD]',
      legacyScaffoldPrompt: '[COMPACT SCAFFOLD]',
    },
    ...overrides,
  };
}

type MatrixCase = {
  name: string;
  input: StepPromptPolicyContext;
  playbooks?: string[];
  plan?: boolean;
  advice?: boolean;
  harness?: boolean;
  scaffold?: boolean;
  fallback?: boolean;
};

const matrix: MatrixCase[] = [
  {
    name: 'simple read-only',
    input: context({ activeStepQuery: 'Read package name and answer' }),
  },
  {
    name: 'docs',
    input: context({
      activeStepQuery: 'Summarize the README documentation',
      classification: classification({ taskClass: 'exploration', phase: 'explore' }),
      harnessProfileName: 'read-only-guard',
    }),
  },
  {
    name: 'architecture',
    input: context({ activeStepQuery: 'Map architecture topology and call graph dependencies' }),
    playbooks: ['architecture'],
  },
  {
    name: 'bugfix explore',
    input: context({
      activeStepQuery: 'Debug root cause of authentication failure',
      classification: classification({ taskClass: 'bugfix', phase: 'explore', risk: 'R2', requiredCapabilities: ['inspect', 'search', 'edit'] }),
      harnessProfileName: 'strict-verification',
    }),
    playbooks: ['rootCause'],
    harness: true,
    scaffold: true,
  },
  {
    name: 'implement',
    input: context({
      activeStepQuery: 'Implement the accepted feature patch',
      classification: classification({ taskClass: 'feature', phase: 'implement', reversibility: 'reversible', requiredCapabilities: ['edit', 'verify'] }),
      harnessProfileName: 'velocity-first',
    }),
    playbooks: ['mutation'],
    harness: true,
  },
  {
    name: 'verify',
    input: context({
      activeStepQuery: 'Run the decisive regression verification',
      classification: classification({ taskClass: 'bugfix', phase: 'verify', requiredCapabilities: ['verify'] }),
      harnessProfileName: 'strict-verification',
      hasValidatedHypothesis: true,
    }),
    playbooks: ['rootCause'],
    harness: true,
  },
  {
    name: 'background command',
    input: context({
      activeStepQuery: 'Poll the running background server task',
      lastToolName: 'manage_task',
      lastToolResult: { status: 'running', taskId: 'task-1' },
    }),
    playbooks: ['longTask'],
  },
  {
    name: 'subagent',
    input: context({
      activeStepQuery: 'Delegate a parallel review to a subagent',
      classification: classification({ requiredCapabilities: ['inspect', 'delegate'] }),
      activeAgentCount: 1,
    }),
    playbooks: ['subagent'],
  },
  {
    name: 'active DAG',
    input: context({
      activeStepQuery: 'Execute the active planned task',
      classification: classification({ phase: 'implement', taskClass: 'feature', requiredCapabilities: ['edit', 'plan'] }),
      hasPlan: true,
      planIncomplete: true,
      readyTaskCount: 1,
      activeTask: { title: 'Implement parser', acceptanceCriteria: 'Tests pass' },
      harnessProfileName: 'velocity-first',
    }),
    playbooks: ['mutation', 'dagPlan'],
    plan: true,
    harness: true,
  },
  {
    name: 'repeated failure',
    input: context({
      activeStepQuery: 'Try a different parser strategy',
      consecutiveFailures: 2,
      failureSignature: 'test failed',
      lastToolResult: { error: 'assertion failed' },
    }),
    playbooks: ['rootCause'],
    advice: true,
    scaffold: true,
  },
  {
    name: 'low-confidence fallback',
    input: context({
      activeStepQuery: 'Ambiguous request',
      classification: classification({ confidence: 0.6 }),
    }),
    fallback: true,
    plan: true,
    advice: true,
    harness: true,
    scaffold: true,
  },
  {
    name: 'post-submission',
    input: context({
      activeStepQuery: 'Return the final answer',
      hasSubmittedSolution: true,
      visibleToolNames: [],
    }),
    advice: true,
  },
];

test('StepPromptPolicy enforce matrix preserves every required block', () => {
  let required = 0;
  let recalled = 0;

  for (const item of matrix) {
    const decision = policy.decide(item.input, 'enforce');
    assert.equal(decision.conservativeFallback, Boolean(item.fallback), item.name);
    assert.deepEqual(decision.selectedPlaybooks, item.playbooks || [], item.name);

    const checks = [
      [item.plan, Boolean(decision.planContext)],
      [item.advice, Boolean(decision.advicePrompt)],
      [item.harness, Boolean(decision.harnessGuidance)],
      [item.scaffold, Boolean(decision.scaffoldPrompt)],
    ] as const;
    for (const [expected, actual] of checks) {
      if (expected) {
        required++;
        if (actual) recalled++;
      } else if (!item.fallback) {
        assert.equal(actual, false, `${item.name}: unexpected prompt block`);
      }
    }

    if (!item.fallback) {
      assert.equal(decision.includeStaticToolPlaybooks, false, item.name);
    }
  }

  assert.equal(recalled / required, 1, 'required-block recall must be 100%');
});

test('simple and final steps omit known context diluters', () => {
  for (const item of [matrix[0], matrix[1], matrix[11]]) {
    const decision = policy.decide(item.input, 'enforce');
    assert.equal(decision.toolPlaybookPrompt, '', item.name);
    assert.equal(decision.planContext, '', item.name);
    assert.equal(decision.harnessGuidance, '', item.name);
    assert.equal(decision.scaffoldPrompt, '', item.name);
  }
});

test('off mode is a legacy prompt snapshot and shadow reports potential savings', () => {
  const input = context({ activeStepQuery: 'Read package name and answer' });
  const off = policy.decide(input, 'off');
  assert.deepEqual({
    staticPlaybooks: off.includeStaticToolPlaybooks,
    toolPlaybooks: off.toolPlaybookPrompt,
    plan: off.planContext,
    advice: off.advicePrompt,
    harness: off.harnessGuidance,
    scaffold: off.scaffoldPrompt,
  }, {
    staticPlaybooks: true,
    toolPlaybooks: '',
    plan: input.candidates.legacyPlanContext,
    advice: input.candidates.advicePrompt,
    harness: input.candidates.harnessGuidance,
    scaffold: input.candidates.legacyScaffoldPrompt,
  });
  assert.equal(off.estimatedTokensSaved, 0);
  assert.ok(SECTION_TOOL_PLAYBOOKS.length > 0);

  const shadow = policy.decide(input, 'shadow' satisfies StepPromptGatingMode);
  assert.equal(shadow.includeStaticToolPlaybooks, true);
  assert.equal(shadow.injectedEstimatedTokens, shadow.estimatedTokensBefore);
  assert.ok(shadow.estimatedTokensSaved > 0);
});
