import assert from 'node:assert/strict';
import test from 'node:test';
import { CriticGate } from './critic-gate.js';

test('CriticGate.evaluateExplorationSufficiency approves scratch files unconditionally', () => {
  const critic = new CriticGate();
  const mockSession = {
    getEvents: () => [],
  } as any;

  const decision = critic.evaluateExplorationSufficiency({
    taskClass: 'bugfix',
    session: mockSession,
    targetFilePath: 'scratch/reproduce_issue.py',
    hasReproduction: false,
    gateMode: 'enforce',
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.score, 100);
});

test('CriticGate.evaluateExplorationSufficiency rejects uninspected production file in enforce mode', () => {
  const critic = new CriticGate();
  const mockSession = {
    getEvents: () => [
      { type: 'tool/call', data: { toolName: 'read_file', args: { path: 'src/other.ts' } } },
    ],
  } as any;

  const decision = critic.evaluateExplorationSufficiency({
    taskClass: 'feature',
    session: mockSession,
    targetFilePath: 'src/target.ts',
    hasReproduction: false,
    gateMode: 'enforce',
  });

  assert.equal(decision.allowed, false);
  assert.ok(decision.score < 60);
  assert.match(decision.reasons[0] || '', /NOT been inspected/);
  assert.ok(decision.critiquePrompt?.includes('DUAL-AGENT EXPLORATION SUFFICIENCY GATE REJECTION'));
});

test('CriticGate.evaluateExplorationSufficiency approves inspected target with reproduction test', () => {
  const critic = new CriticGate();
  const mockSession = {
    getEvents: () => [
      { type: 'tool/call', data: { toolName: 'read_file', args: { path: 'src/target.ts' } } },
    ],
  } as any;

  const decision = critic.evaluateExplorationSufficiency({
    taskClass: 'bugfix',
    session: mockSession,
    targetFilePath: 'src/target.ts',
    hasReproduction: true,
    gateMode: 'enforce',
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.score, 100);
  assert.equal(decision.reasons.length, 0);
});

test('CriticGate penalizes score when DomainIntentGuardian records test tampering', () => {
  const critic = new CriticGate();
  const mockSession = {
    getEvents: () => [
      { type: 'tool/call', data: { toolName: 'read_file', args: { path: 'src/target.ts' } } },
    ],
  } as any;

  const mockGuardian = {
    getAuditSummary: () => ({ blockedTamperAttempts: 1, consecutiveDriftWarnings: 0 }),
  } as any;

  const sufficiency = critic.evaluateExplorationSufficiency({
    taskClass: 'bugfix',
    session: mockSession,
    targetFilePath: 'src/target.ts',
    hasReproduction: true,
    domainGuardian: mockGuardian,
    gateMode: 'enforce',
  });

  assert.equal(sufficiency.score, 70); // 100 - 30
  assert.match(sufficiency.reasons[0] || '', /test tampering attempt/);
});

test('CriticGate.evaluateExplorationSufficiency rejects bugfix without reproduction or supported hypothesis in enforce mode', () => {
  const critic = new CriticGate();
  const mockSession = {
    getEvents: () => [
      { type: 'tool/call', data: { toolName: 'read_file', args: { path: 'src/target.ts' } } },
    ],
  } as any;

  const decision = critic.evaluateExplorationSufficiency({
    taskClass: 'bugfix',
    session: mockSession,
    targetFilePath: 'src/target.ts',
    hasReproduction: false,
    gateMode: 'enforce',
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.score, 50); // 100 - 50
  assert.match(decision.reasons[0] || '', /No failing reproduction test execution/);
});

test('CriticGate.evaluateExplorationSufficiency approves bugfix without reproduction if hypothesis is supported', () => {
  const critic = new CriticGate();
  const mockSession = {
    getEvents: () => [
      { type: 'tool/call', data: { toolName: 'read_file', args: { path: 'src/target.ts' } } },
    ],
  } as any;

  const mockHypothesisTracker = {
    getLatestHypothesis: () => ({
      id: 'hypo-1',
      statement: 'Off by one error in index calculation',
      status: 'supported',
    }),
  } as any;

  const decision = critic.evaluateExplorationSufficiency({
    taskClass: 'bugfix',
    session: mockSession,
    targetFilePath: 'src/target.ts',
    hasReproduction: false,
    hypothesisTracker: mockHypothesisTracker,
    gateMode: 'enforce',
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.score, 100);
  assert.equal(decision.reasons.length, 0);
});

test('CriticGate.evaluateExplorationSufficiency blocks mutation if latest hypothesis was falsified', () => {
  const critic = new CriticGate();
  const mockSession = {
    getEvents: () => [
      { type: 'tool/call', data: { toolName: 'read_file', args: { path: 'src/target.ts' } } },
    ],
  } as any;

  const mockHypothesisTracker = {
    getLatestHypothesis: () => ({
      id: 'hypo-1',
      statement: 'Off by one error in index calculation',
      status: 'falsified',
      rejectionReason: 'Index is actually zero-based and valid',
    }),
  } as any;

  const decision = critic.evaluateExplorationSufficiency({
    taskClass: 'bugfix',
    session: mockSession,
    targetFilePath: 'src/target.ts',
    hasReproduction: true,
    hypothesisTracker: mockHypothesisTracker,
    gateMode: 'enforce',
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.score, 50); // 100 - 50
  assert.match(decision.reasons[0] || '', /FALSIFIED/);
});

test('CriticGate.evaluateExplorationSufficiency advises (not blocks) single-file inspection without call-graph evidence', () => {
  const critic = new CriticGate();
  const supportedHypo = {
    getLatestHypothesis: () => ({ id: 'hypo-1', statement: 'Off-by-one', status: 'supported' }),
  } as any;
  // Only target.ts inspected (1 file), no call-graph tool ran
  const singleFileSession = {
    getEvents: () => [
      { type: 'tool/call', data: { toolName: 'read_file', args: { path: 'src/target.ts' } } },
      { type: 'tool/call', data: { toolName: 'read_file', args: { path: 'scratch/repro.py' } } }, // scratch does not count
    ],
  } as any;

  const advisoryDecision = critic.evaluateExplorationSufficiency({
    taskClass: 'bugfix',
    session: singleFileSession,
    targetFilePath: 'src/target.ts',
    hasReproduction: false,
    hypothesisTracker: supportedHypo,
    risk: 'R3',
    gateMode: 'enforce',
  });

  assert.equal(advisoryDecision.allowed, true);
  assert.equal(advisoryDecision.score, 100);
  assert.ok(advisoryDecision.reasons.some((r) => r.includes('CAUSAL_TRACE_UNVERIFIED')));

  // Now inspect caller file as well (2 files)
  const causalChainSession = {
    getEvents: () => [
      { type: 'tool/call', data: { toolName: 'read_file', args: { path: 'src/target.ts' } } },
      { type: 'tool/call', data: { toolName: 'read_file', args: { path: 'src/caller.ts' } } },
    ],
  } as any;

  const approvedDecision = critic.evaluateExplorationSufficiency({
    taskClass: 'bugfix',
    session: causalChainSession,
    targetFilePath: 'src/target.ts',
    hasReproduction: false,
    hypothesisTracker: supportedHypo,
    risk: 'R3',
    gateMode: 'enforce',
  });

  assert.equal(approvedDecision.allowed, true);
  assert.equal(approvedDecision.score, 100);
  assert.equal(approvedDecision.reasons.length, 0);
});

test('CriticGate passes measured single-locus fixes with zero callers', () => {
  const critic = new CriticGate();
  const supportedHypo = {
    getLatestHypothesis: () => ({ id: 'hypo-1', statement: 'Off-by-one', status: 'supported' }),
  } as any;
  const measuredSession = {
    getEvents: () => [
      { type: 'tool/call', data: { toolName: 'read_file', args: { path: 'src/target.ts' } } },
      { type: 'tool/call', data: { toolName: 'analyze_impact', args: { target: 'src/target.ts' } } },
      { type: 'tool/result', data: { toolName: 'analyze_impact', result: { callers: 0, risk: 'LOW' } } },
    ],
  } as any;

  const decision = critic.evaluateExplorationSufficiency({
    taskClass: 'bugfix',
    session: measuredSession,
    targetFilePath: 'src/target.ts',
    hasReproduction: false,
    hypothesisTracker: supportedHypo,
    risk: 'R3',
    gateMode: 'enforce',
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.score, 100);
  assert.ok(decision.reasons.some((r) => r.includes('single-locus')));
});

test('CriticGate still blocks when measured callers exist but are uninspected', () => {
  const critic = new CriticGate();
  const supportedHypo = {
    getLatestHypothesis: () => ({ id: 'hypo-1', statement: 'Off-by-one', status: 'supported' }),
  } as any;
  const gapSession = {
    getEvents: () => [
      { type: 'tool/call', data: { toolName: 'read_file', args: { path: 'src/target.ts' } } },
      { type: 'tool/call', data: { toolName: 'analyze_impact', args: { target: 'src/target.ts' } } },
      { type: 'tool/result', data: { toolName: 'analyze_impact', result: { callers: 3, risk: 'MEDIUM' } } },
    ],
  } as any;

  const decision = critic.evaluateExplorationSufficiency({
    taskClass: 'bugfix',
    session: gapSession,
    targetFilePath: 'src/target.ts',
    hasReproduction: false,
    hypothesisTracker: supportedHypo,
    risk: 'R3',
    gateMode: 'enforce',
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.score, 50);
  assert.ok(decision.reasons.some((r) => r.includes('CAUSAL_TRACE_INSUFFICIENT')));
});
test('Pillar E2: Exploration Exhaustion Gate penalizes zero-evidence answers on architecture/investigation queries', () => {
  const critic = new CriticGate();
  const emptySession = {
    getEvents: () => [],
  } as any;

  // Architecture query with 0 inspected files
  const archDecision = critic.evaluateExplorationExhaustion({
    userRequest: 'Giải thích kiến trúc và luồng xử lý của hệ thống',
    session: emptySession,
    finalAnswer: 'Hệ thống dùng mô hình microservices.',
  });
  assert.equal(archDecision.allowed, false);
  assert.equal(archDecision.scorePenalty, 40);
  assert.ok(archDecision.reasons[0].includes('EXPLORATION_EXHAUSTED_ZERO_EVIDENCE'));

  // Single-file satisficing on defect investigation
  const singleFileSession = {
    getEvents: () => [
      { type: 'tool/call', data: { toolName: 'read_file', args: { path: 'src/auth.ts' } } },
    ],
  } as any;

  const defectDecision = critic.evaluateExplorationExhaustion({
    userRequest: 'Tại sao hàm login lại bị lỗi timeout? Có phải do token hết hạn không?',
    session: singleFileSession,
    finalAnswer: 'Do token hết hạn.',
  });
  assert.equal(defectDecision.scorePenalty, 20);
  assert.ok(defectDecision.reasons[0].includes('PREMATURE_SEARCH_CLOSURE'));

  // Multi-file exploration passes
  const multiFileSession = {
    getEvents: () => [
      { type: 'tool/call', data: { toolName: 'read_file', args: { path: 'src/auth.ts' } } },
      { type: 'tool/call', data: { toolName: 'read_file', args: { path: 'src/token-verifier.ts' } } },
    ],
  } as any;

  const thoroughDecision = critic.evaluateExplorationExhaustion({
    userRequest: 'Tại sao hàm login lại bị lỗi timeout?',
    session: multiFileSession,
    finalAnswer: 'Đã kiểm tra auth và token-verifier.',
  });
  assert.equal(thoroughDecision.allowed, true);
  assert.equal(thoroughDecision.scorePenalty, 0);
});
