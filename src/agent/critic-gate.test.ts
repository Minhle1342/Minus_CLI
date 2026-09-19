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

