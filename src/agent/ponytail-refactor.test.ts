import test from 'node:test';
import assert from 'node:assert/strict';
import { isScratchFilePath } from './agent-loop.js';
import { isScratchPath } from '../skills/verification-policy.js';

test('isScratchFilePath and isScratchPath exhibit identical behavior', () => {
  const scratchFile = '.minus/scratch/sample.ts';
  const normalFile = 'src/index.ts';

  assert.equal(isScratchFilePath(scratchFile), isScratchPath(scratchFile));
  assert.equal(isScratchFilePath(normalFile), isScratchPath(normalFile));
  assert.equal(isScratchFilePath(scratchFile), true);
  assert.equal(isScratchFilePath(normalFile), false);
});

test('hypothesisBlastRadiusRisk correctly ranks highest risk', async () => {
  const { hypothesisBlastRadiusRisk } = await import('./agent-loop.js');
  assert.equal(hypothesisBlastRadiusRisk([{ blastRadius: 'LOW' }, { blastRadius: 'CRITICAL' }]), 'R5');
  assert.equal(hypothesisBlastRadiusRisk([{ blastRadius: 'MEDIUM' }, { blastRadius: 'HIGH' }]), 'R3');
  assert.equal(hypothesisBlastRadiusRisk([{ blastRadius: 'UNKNOWN' }]), 'R0');
  assert.equal(hypothesisBlastRadiusRisk([]), undefined);
});
