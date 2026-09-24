import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Session } from '../session/session.js';
import { Workspace } from '../workspace/workspace.js';
import { attributeCommandFailure, captureCommandBaseline } from './command-regression-evidence.js';

async function withWorkspace(run: (session: Session, workspace: Workspace, root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-command-regression-'));
  try {
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'legacy.ts'), 'const legacy: number = "bad";');
    await fs.writeFile(path.join(root, 'src', 'changed.ts'), 'export const changed = 1;');
    const session = new Session();
    session.append('turn/start', { turn: 1 });
    await run(session, new Workspace(root), root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const existing = 'src/legacy.ts(1,7): error TS2322: Type \'string\' is not assignable to type \'number\'.';
const failure = (stdout = existing) => ({ commandOutcome: 'failed_unexpected', exitCode: 2, success: false,
  stdout, stderr: '', sandbox: 'local', executionTarget: 'host' });

test('same pre-edit failure in an unchanged, out-of-scope source is certified from the same command', async () => {
  await withWorkspace(async (session, workspace, root) => {
    const baseline = await captureCommandBaseline(session, 1, 'npm run build', failure(), workspace);
    assert.equal(baseline?.complete, true);
    const restored = Session.fromSnapshot(session.toSnapshot());
    await fs.writeFile(path.join(root, 'src', 'changed.ts'), 'export const changed = 2;');
    const evidence = await attributeCommandFailure(restored, 1, 'npm run build', failure(), workspace,
      ['src/changed.ts'], 12);
    assert.equal(evidence.classification, 'pre_existing_out_of_scope');
    assert.equal(evidence.preExisting[0].file, 'src/legacy.ts');
    assert.equal(evidence.baselineResultSeq, baseline?.resultSeq);
  });
});

test('changed source and newly appeared diagnostics are never certified as pre-existing', async () => {
  await withWorkspace(async (session, workspace, root) => {
    await captureCommandBaseline(session, 1, 'npm run build', failure(), workspace);
    await fs.writeFile(path.join(root, 'src', 'legacy.ts'), 'const legacy: number = "changed";');
    const changed = await attributeCommandFailure(session, 1, 'npm run build', failure(), workspace,
      ['src/legacy.ts'], 12);
    assert.equal(changed.classification, 'new_failures_detected');
    const extra = `${existing}\nsrc/changed.ts(1,1): error TS2304: Cannot find name 'missing'.`;
    const mixed = await attributeCommandFailure(session, 1, 'npm run build', failure(extra), workspace,
      ['src/changed.ts'], 12);
    assert.equal(mixed.classification, 'new_failures_detected');
    assert.equal(mixed.newFailures.length, 2);
  });
});

test('no baseline, incomplete output, different command/runtime, and unsupported errors remain undetermined', async () => {
  await withWorkspace(async (session, workspace) => {
    assert.equal((await attributeCommandFailure(session, 1, 'npm run build', failure(), workspace, [], 12)).classification, 'undetermined');
    const baseline = await captureCommandBaseline(session, 1, 'npm run build', failure(), workspace);
    const noMutation = await attributeCommandFailure(session, 1, 'npm run build', failure(), workspace, [], baseline!.resultSeq);
    assert.equal(noMutation.classification, 'undetermined');
    assert.equal((await attributeCommandFailure(session, 1, 'npm test', failure(), workspace, [], 12)).classification, 'undetermined');
    assert.equal((await attributeCommandFailure(session, 1, 'npm run build', { ...failure(), sandbox: 'docker' }, workspace, [], 12)).classification, 'undetermined');
    assert.equal((await attributeCommandFailure(session, 1, 'npm run build', { ...failure(), verificationOutputComplete: false }, workspace, [], 12)).classification, 'undetermined');
    assert.equal((await attributeCommandFailure(session, 1, 'npm run build', failure('Some unrelated test failed'), workspace, [], 12)).classification, 'undetermined');
  });
});

test('a clean pre-edit run identifies new diagnostics after a later mutation', async () => {
  await withWorkspace(async (session, workspace) => {
    await captureCommandBaseline(session, 1, 'npm run build', { ...failure(''), stdout: '', exitCode: 0, success: true, commandOutcome: 'succeeded' }, workspace);
    const evidence = await attributeCommandFailure(session, 1, 'npm run build', failure(), workspace, ['src/changed.ts'], 12);
    assert.equal(evidence.classification, 'new_failures_detected');
  });
});
