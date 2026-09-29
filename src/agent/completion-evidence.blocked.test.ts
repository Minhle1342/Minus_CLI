import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../session/session.js';
import { CompletionEvidenceGate } from './completion-evidence.js';

function failedCloneSession(): Session {
  const s = new Session('test-blocked-404');
  s.append('turn/start', { turn: 1 } as any);
  s.append('tool/call', { turn: 1, toolName: 'run_node_script', toolCallId: 'c1', args: {} } as any);
  s.append('tool/result', {
    turn: 1, toolName: 'run_node_script', toolCallId: 'c1',
    result: { success: false, exitCode: 1, error: "remote: Repository not found. fatal: repository not found", stderr: 'Repository not found' },
  } as any);
  return s;
}

describe('completion gate blocked investigation (repo 404)', () => {
  it('rejects investigation_only without failure evidence (no hallucinated blocker)', () => {
    const s = new Session('test-empty');
    s.append('turn/start', { turn: 1 } as any);
    const gate = new CompletionEvidenceGate();
    const d = gate.evaluate('Repo blocked, cannot clone.', s, { turn: 1, codeChangeRequired: true, resolutionType: 'investigation_only' });
    assert.equal(d.allow, false);
  });

  it('allows investigation_only when failed clone observation exists', () => {
    const s = failedCloneSession();
    const gate = new CompletionEvidenceGate();
    const d = gate.evaluate(
      'Kho luu tru khong ton tai (404 Not Found). Da thu git clone va ls-remote deu that bai do repository not found, khong the tiep tuc.',
      s,
      { turn: 1, codeChangeRequired: true, taskClass: 'feature', resolutionType: 'investigation_only' },
    );
    assert.equal(d.allow, true);
  });

  it('still requires mutation for code_fix without evidence', () => {
    const s = failedCloneSession();
    const gate = new CompletionEvidenceGate();
    const d = gate.evaluate('Fixed bug.', s, { turn: 1, codeChangeRequired: true, taskClass: 'feature', resolutionType: 'code_fix' });
    assert.equal(d.allow, false);
    assert.ok(d.reasons.join(' ').includes('code change'));
  });
});
