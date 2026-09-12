import assert from 'node:assert/strict';
import test from 'node:test';
import { DynamicContextArbiter } from './dynamic-context-arbiter.js';
import { StepPromptPolicy } from './step-prompt-policy.js';
import { detectBugReportIntent } from './tool-synergy-advisor.js';
import type { ClassificationDecision } from '../control/classification-types.js';

test('DynamicContextArbiter deduplicates memoryPrompt against existingHistoryContext', () => {
  const arbiter = new DynamicContextArbiter(2000);
  const warmStartHistory = `[PROJECT KNOWLEDGE BASE - WARM START MEMORY]
- Stack: TypeScript, Node.js
[SESSION / GOAL MEMORY - RETRIEVED BY RELEVANCE]
- [auth/token; confidence=0.95] Use Bearer token authorization header in API requests
- [cache/redis; confidence=0.88] Cache key expires after 3600 seconds`;

  const dynamicInputs = {
    memoryPrompt: `[VERIFIED RELEVANT PROJECT MEMORY]
- [auth/token; confidence=0.95] Use Bearer token authorization header in API requests
- [database/pool; confidence=0.90] PostgreSQL pool size is 20 connections`,
  };

  const result = arbiter.arbitrate(dynamicInputs, {
    maxBudgetTokens: 2000,
    existingHistoryContext: warmStartHistory,
  });

  // Mục auth/token đã có trong warm-start history phải bị loại bỏ
  assert.ok(!result.renderedContext.includes('Bearer token authorization header'), 'Đã khử trùng auth/token insight');
  // Mục database/pool chưa có trong warm-start history phải được giữ lại
  assert.ok(result.renderedContext.includes('PostgreSQL pool size is 20 connections'), 'Giữ lại database/pool mới');
});

test('DynamicContextArbiter clears memoryPrompt completely when all items are duplicated', () => {
  const arbiter = new DynamicContextArbiter(2000);
  const warmStartHistory = `[SESSION / GOAL MEMORY - RETRIEVED BY RELEVANCE]
- [auth/token; confidence=0.95] Use Bearer token authorization header in API requests`;

  const dynamicInputs = {
    memoryPrompt: `[VERIFIED RELEVANT PROJECT MEMORY]
- [auth/token; confidence=0.95] Use Bearer token authorization header in API requests`,
  };

  const result = arbiter.arbitrate(dynamicInputs, {
    maxBudgetTokens: 2000,
    existingHistoryContext: warmStartHistory,
  });

  assert.equal(result.renderedContext.trim(), '', 'memoryPrompt hoàn toàn trống khi 100% mục bị trùng');
  assert.equal(result.sourcesIncluded.includes('Project Memory (P4)'), false);
});

test('Step 1 Bug Report Intent detection triggers Playbook B guidance', () => {
  const bugReportPrompt = 'Fix bug where user cannot login due to undefined token exception';
  const normalPrompt = 'Show me the project architecture and file tree';

  assert.equal(detectBugReportIntent(bugReportPrompt), true, 'Phát hiện intent báo lỗi trong prompt');
  assert.equal(detectBugReportIntent(normalPrompt), false, 'Prompt câu hỏi thông thường không bị coi là bug report');
});

test('StepPromptPolicy recognizes initial bug report in actionableAdvice', () => {
  const policy = new StepPromptPolicy();
  const dummyClassification: ClassificationDecision = {
    id: 'c-test',
    version: 1,
    taskClass: 'bugfix',
    phase: 'explore',
    complexity: 'medium',
    externality: 'local',
    reversibility: 'reversible',
    risk: 'R2',
    requiredCapabilities: ['inspect', 'search', 'edit'],
    confidence: 0.95,
    fastPath: false,
    reasonCodes: [],
    createdAt: new Date().toISOString(),
  };

  const bugContext = {
    activeStepQuery: 'Fix bug with parser crash',
    fingerprint: 'fp-1',
    classification: dummyClassification,
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
    harnessProfileName: 'strict-verification' as const,
    candidates: {
      legacyPlanContext: '',
      stepPlanContext: '',
      advicePrompt: '[5-STAGE ROOT CAUSE PROTOCOL] User reported a bug',
      advicePlaybook: 'B_DEBUGGING',
      harnessGuidance: '',
      scaffoldPrompt: '',
      legacyScaffoldPrompt: '',
    },
  };

  const decision = policy.decide(bugContext, 'enforce');
  assert.equal(decision.advicePrompt, '[5-STAGE ROOT CAUSE PROTOCOL] User reported a bug', 'Initial bug report kích hoạt actionable advice');
});
