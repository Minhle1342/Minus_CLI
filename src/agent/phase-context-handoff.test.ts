import assert from 'node:assert/strict';
import test from 'node:test';
import { Session } from '../session/session.js';
import { DynamicContextArbiter } from './dynamic-context-arbiter.js';
import { buildPhaseContextHandoff } from './phase-context-handoff.js';

test('handoff only includes session-backed inspected files and a supported hypothesis', () => {
  const session = new Session();
  session.append('phase/exploreCompleted', {
    turn: 1,
    phaseTransition: { classificationId: 'class-1', hypothesisId: 'H1', evidenceScore: 3, evidenceThreshold: 3,
      inspectedFiles: ['src/auth.ts'], reason: 'evidence-admitted' },
  });
  const unproven = buildPhaseContextHandoff(session, 1, 'implement', {
    id: 'H1', status: 'formulated', statement: 'guess', falsificationTest: '', targetFiles: [],
    blastRadius: 'LOW', proposedFix: '', createdAt: '',
  });
  assert.match(unproven!.text, /Inspected: src\/auth.ts/);
  assert.doesNotMatch(unproven!.text, /guess/);
  const proven = buildPhaseContextHandoff(session, 1, 'implement', {
    id: 'H1', status: 'supported', statement: 'upstream caller sends empty input', falsificationTest: '',
    targetFiles: [], blastRadius: 'LOW', proposedFix: '', createdAt: '',
  });
  assert.match(proven!.text, /upstream caller sends empty input/);
  assert.doesNotMatch(buildPhaseContextHandoff(session, 1, 'implement', {
    id: 'H2', status: 'supported', statement: 'unrelated task hypothesis', falsificationTest: '',
    targetFiles: [], blastRadius: 'LOW', proposedFix: '', createdAt: '',
  })!.text, /unrelated task hypothesis/);
  assert.equal(buildPhaseContextHandoff(session, 2, 'implement'), undefined);
});

test('verify handoff uses only the current mutation and disappears after invalidation', () => {
  const session = new Session();
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('tool/call', { turn: 1, step: 1, toolName: 'replace_text', toolCallId: 'edit', args: { path: 'src/auth.ts' } });
  const mutation = session.append('tool/result', { turn: 1, step: 1, toolName: 'replace_text', toolCallId: 'edit', result: { success: true, path: 'src/auth.ts' } });
  session.append('phase/implementationCompleted', { turn: 1, phaseTransition: {
    mutationSeq: mutation.seq, filesModified: ['src/auth.ts'], verificationCommand: 'npm test', reason: 'verification-started',
  } });
  const handoff = buildPhaseContextHandoff(session, 1, 'verify', undefined, ['tests/auth.test.ts']);
  assert.match(handoff!.text, /Verification still required/);
  assert.match(handoff!.text, /tests\/auth.test.ts/);
  session.append('phase/verificationCompleted', { turn: 1, phaseTransition: {
    mutationSeq: mutation.seq, verificationCommand: 'npm test', reason: 'verification-policy-passed',
  } });
  assert.match(buildPhaseContextHandoff(session, 1, 'verify')!.text, /Verification passed: npm test/);
  session.append('phase/invalidated', { turn: 1, phaseTransition: { mutationSeq: mutation.seq, reason: 'new-observed-mutation' } });
  assert.equal(buildPhaseContextHandoff(session, 1, 'verify'), undefined);
});

test('phase handoff survives pruning of lower-priority dynamic context', () => {
  const result = new DynamicContextArbiter().arbitrate({
    phaseHandoff: '[PHASE HANDOFF] Observed mutation #5; verify npm test.',
    repositoryContext: 'irrelevant repository map '.repeat(500),
  }, { maxBudgetTokens: 180, modelName: 'gemini-3.5-flash' });
  assert.ok(result.sourcesIncluded.includes('Phase Handoff (P1.5)'));
  assert.match(result.renderedContext, /Observed mutation #5/);
});
