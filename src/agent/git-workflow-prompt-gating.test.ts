import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClassificationDecision } from '../control/classification-types.js';
import { GIT_WORKFLOW_PROMPTS } from '../llm/prompt-sections.js';
import { DynamicContextArbiter } from './dynamic-context-arbiter.js';
import {
  StepPromptPolicy,
  type StepPromptPolicyContext,
} from './step-prompt-policy.js';

const policy = new StepPromptPolicy();

function makeClassification(overrides: Partial<ClassificationDecision> = {}): ClassificationDecision {
  return {
    id: 'classification-test',
    version: 1,
    taskClass: 'feature',
    phase: 'explore',
    complexity: 'medium',
    externality: 'local',
    reversibility: 'reversible',
    risk: 'R1',
    requiredCapabilities: ['inspect', 'edit'],
    confidence: 0.95,
    fastPath: false,
    reasonCodes: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeContext(overrides: Partial<StepPromptPolicyContext> = {}): StepPromptPolicyContext {
  return {
    activeStepQuery: 'Inspect the codebase and explain the auth flow',
    fingerprint: 'fp-git-test',
    classification: makeClassification(),
    hasPlan: false,
    planRequired: false,
    planIncomplete: false,
    planBlocked: false,
    readyTaskCount: 0,
    visibleToolNames: ['read_file', 'run_command'],
    consecutiveFailures: 0,
    hasValidatedHypothesis: false,
    hasSubmittedSolution: false,
    hasVerifiedTests: false,
    activeAgentCount: 0,
    harnessProfileName: 'balanced-default',
    candidates: {
      legacyPlanContext: '[LEGACY PLAN]',
      stepPlanContext: '[STEP PLAN]',
      advicePrompt: '[ADVICE]',
      advicePlaybook: 'GENERAL',
      harnessGuidance: '[HARNESS]',
      scaffoldPrompt: '[SCAFFOLD]',
      legacyScaffoldPrompt: '[SCAFFOLD]',
    },
    ...overrides,
  };
}

test('Git gating: Default step has 0 Git playbook tokens and undefined selectedGitPlaybook', () => {
  const ctx = makeContext({
    activeStepQuery: 'Refactor helper function to use Array.prototype.map',
    classification: makeClassification({ phase: 'implement', taskClass: 'refactor' }),
  });
  const decision = policy.decide(ctx, 'enforce');

  assert.equal(decision.selectedGitPlaybook, undefined);
  assert.equal(decision.gitPlaybookPrompt, '');
  assert.ok(!decision.reasonCodes.some((code) => code.startsWith('GIT_PLAYBOOK_')));
});

test('Git gating: Baseline inspection is triggered in explore phase with git status query', () => {
  const ctx = makeContext({
    activeStepQuery: 'Kiểm tra trạng thái git status và xem uncommitted changes',
    classification: makeClassification({ phase: 'explore' }),
  });
  const decision = policy.decide(ctx, 'enforce');

  assert.equal(decision.selectedGitPlaybook, 'gitInspect');
  assert.equal(decision.gitPlaybookPrompt, GIT_WORKFLOW_PROMPTS.gitInspect);
  assert.ok(decision.gitPlaybookPrompt.includes('git status -s'));
  assert.ok(decision.reasonCodes.includes('GIT_PLAYBOOK_GITINSPECT'));
});

test('Git gating: Branch isolation is triggered in plan phase with branch intent', () => {
  const ctx = makeContext({
    activeStepQuery: 'Tạo branch mới để isolate tính năng đăng nhập và checkout -b feature/login',
    classification: makeClassification({ phase: 'plan' }),
  });
  const decision = policy.decide(ctx, 'enforce');

  assert.equal(decision.selectedGitPlaybook, 'gitBranch');
  assert.equal(decision.gitPlaybookPrompt, GIT_WORKFLOW_PROMPTS.gitBranch);
  assert.ok(decision.gitPlaybookPrompt.includes('git checkout -b'));
  assert.ok(decision.reasonCodes.includes('GIT_PLAYBOOK_GITBRANCH'));
});

test('Git gating: Atomic staging & commit is triggered when tests are verified', () => {
  const ctx = makeContext({
    activeStepQuery: 'Tất cả test đã pass, chuẩn bị đóng gói commit',
    classification: makeClassification({ phase: 'verify' }),
    hasVerifiedTests: true,
    consecutiveFailures: 0,
  });
  const decision = policy.decide(ctx, 'enforce');

  assert.equal(decision.selectedGitPlaybook, 'gitCommit');
  assert.equal(decision.gitPlaybookPrompt, GIT_WORKFLOW_PROMPTS.gitCommit);
  assert.ok(decision.gitPlaybookPrompt.includes('git add <file1> <file2>'));
  assert.ok(decision.gitPlaybookPrompt.includes('NEVER use `git add .`'));
  assert.ok(decision.reasonCodes.includes('GIT_PLAYBOOK_GITCOMMIT'));
});

test('Git gating: PR enhancement playbook is triggered for PR review and enhancement queries', () => {
  const ctx = makeContext({
    activeStepQuery: 'Tạo mô tả PR chi tiết với verification proof và risk assessment /git-pr-workflows-pr-enhance',
    classification: makeClassification({ phase: 'verify' }),
    hasVerifiedTests: true,
  });
  const decision = policy.decide(ctx, 'enforce');

  assert.equal(decision.selectedGitPlaybook, 'gitPrEnhance');
  assert.equal(decision.gitPlaybookPrompt, GIT_WORKFLOW_PROMPTS.gitPrEnhance);
  assert.ok(decision.gitPlaybookPrompt.includes('Structured PR Description'));
  assert.ok(decision.gitPlaybookPrompt.includes('Review Checklist'));
  assert.ok(decision.gitPlaybookPrompt.includes('Verification Evidence'));
  assert.ok(decision.gitPlaybookPrompt.includes('Risk Assessment'));
  assert.ok(decision.gitPlaybookPrompt.includes('NEVER run git push --force'));
  assert.ok(decision.reasonCodes.includes('GIT_PLAYBOOK_GITPRENHANCE'));
});

test('Git gating: Safe rollback & stash is triggered on consecutive failures or revert query', () => {
  const ctxFails = makeContext({
    activeStepQuery: 'Kiểm tra lỗi build',
    classification: makeClassification({ phase: 'implement' }),
    consecutiveFailures: 2,
  });
  const decisionFails = policy.decide(ctxFails, 'enforce');
  assert.equal(decisionFails.selectedGitPlaybook, 'gitRollback');
  assert.equal(decisionFails.gitPlaybookPrompt, GIT_WORKFLOW_PROMPTS.gitRollback);
  assert.ok(decisionFails.gitPlaybookPrompt.includes('git restore <path>'));
  assert.ok(decisionFails.gitPlaybookPrompt.includes('NEVER execute destructive `git reset --hard`'));
  assert.ok(decisionFails.reasonCodes.includes('GIT_PLAYBOOK_GITROLLBACK'));

  const ctxRevert = makeContext({
    activeStepQuery: 'Lỗi nặng quá, cần rollback hoặc stash lại thay đổi',
    classification: makeClassification({ phase: 'implement' }),
    consecutiveFailures: 0,
  });
  const decisionRevert = policy.decide(ctxRevert, 'enforce');
  assert.equal(decisionRevert.selectedGitPlaybook, 'gitRollback');
});

test('DynamicContextArbiter integrates gitPlaybook at P1.35 without truncation', () => {
  const arbiter = new DynamicContextArbiter(2000);
  const result = arbiter.arbitrate({
    advicePrompt: '[ADVICE PROMPT]',
    toolPlaybooks: '[TOOL PLAYBOOKS]',
    gitPlaybook: GIT_WORKFLOW_PROMPTS.gitPrEnhance,
    harnessGuidance: '[HARNESS GUIDANCE]',
  }, { modelName: 'gemini-2.5-flash' });

  assert.ok(result.renderedContext.includes('PULL REQUEST ENHANCEMENT'));
  assert.ok(result.sourcesIncluded.includes('Git Workflow Playbook (P1.35)'));
  assert.ok(!result.sourcesTruncated.includes('Git Workflow Playbook (P1.35)'));
  assert.ok(!result.sourcesPruned.includes('Git Workflow Playbook (P1.35)'));
});
