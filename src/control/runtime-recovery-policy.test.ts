import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EpistemicInvestigationGating } from '../agent/epistemic-investigation-engine.js';
import { ProjectMemoryManager } from '../memory/project-memory.js';
import { Workspace } from '../workspace/workspace.js';
import { ClassificationEngine } from './classification-engine.js';
import { isReadOnlyRequest, normalizeRequestIntentText } from './request-intent.js';

test('Vietnamese mutation requests retain edit capability after an operational failure', () => {
  const engine = new ClassificationEngine();
  const request = 'Bổ sung thêm những điểm còn thiếu và thực thi cải tiến';
  const initial = engine.classify({ request });

  assert.equal(normalizeRequestIntentText('Thực thi cải tiến'), 'thuc thi cai tien');
  assert.equal(isReadOnlyRequest(request), false);
  assert.equal(initial.taskClass, 'feature');
  assert.equal(initial.phase, 'implement');
  assert.ok(initial.requiredCapabilities.includes('edit'));

  const recovered = engine.classify({
    request,
    previous: initial,
    lastToolName: 'run_command',
    lastToolFailed: true,
  });

  assert.equal(recovered.phase, 'implement');
  assert.ok(recovered.requiredCapabilities.includes('edit'));
  assert.ok(recovered.reasonCodes.includes('FAILED_ACTION_PRESERVE_MUTATION_CAPABILITY'));
});

test('read-only Vietnamese investigations remain read-only', () => {
  const classification = new ClassificationEngine().classify({
    request: 'Kiểm tra nguyên nhân gây ngắt runtime và báo cáo kết quả',
  });

  assert.equal(classification.taskClass, 'exploration');
  assert.equal(classification.phase, 'explore');
  assert.equal(classification.requiredCapabilities.includes('edit'), false);
});

test('operational failures bypass epistemic dual investigation', () => {
  for (const errorCode of ['PACKAGE_JSON_NOT_FOUND', 'TOOL_NOT_ALLOWED_THIS_TURN']) {
    const decision = EpistemicInvestigationGating.shouldActivate({
      phase: 'explore',
      risk: 'HIGH',
      consecutiveFailures: 2,
      recentError: `Failure: ${errorCode}`,
    });

    assert.equal(decision.activate, false);
    assert.match(decision.reason, /deterministic recovery/i);
  }

  const genuineFailure = EpistemicInvestigationGating.shouldActivate({
    phase: 'explore',
    risk: 'HIGH',
    consecutiveFailures: 2,
    recentError: 'AssertionError: expected schema to match',
  });
  assert.equal(genuineFailure.activate, true);
});

test('warm-start memory emits native .NET commands instead of npm wrappers', async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-dotnet-memory-'));
  t.after(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(workspaceDir, 'Example.sln'), '');

  const memory = new ProjectMemoryManager(workspaceDir);
  await memory.init(new Workspace(workspaceDir));
  const digest = memory.getProjectDigest();

  assert.match(digest, /"test": dotnet test/);
  assert.match(digest, /"build": dotnet build/);
  assert.doesNotMatch(digest, /"test": npm run test/);
});
