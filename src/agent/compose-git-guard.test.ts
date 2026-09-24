import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Workspace } from '../workspace/workspace.js';
import { ComposeController } from './compose-controller.js';

async function activeComposeInWorktree(): Promise<{ controller: ComposeController; workspace: Workspace; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-compose-git-'));
  const worktree = path.join(root, 'worktree');
  await fs.mkdir(worktree, { recursive: true });
  const state = {
    version: 1,
    id: 'compose-test',
    featureName: 'test feature',
    objective: 'test objective',
    phase: 'IMPLEMENTING',
    specPath: 'spec.md',
    grillQnA: [],
    implementationTasks: [],
    registeredFiles: [],
    testMatrix: [],
    evidenceSeq: 0,
    lastMutationSeq: 0,
    worktreePath: worktree,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await fs.mkdir(path.join(root, '.codingagent', 'compose'), { recursive: true });
  await fs.writeFile(path.join(root, '.codingagent', 'compose', 'state.json'), JSON.stringify(state));
  const controller = new ComposeController(root);
  await controller.init();
  assert.equal(controller.isActive(), true);
  return {
    controller,
    workspace: new Workspace(worktree),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

test('compose blocks run_command git writes inside its own worktree', async () => {
  const { controller, workspace, cleanup } = await activeComposeInWorktree();
  try {
    const commit = await controller.check('run_command', { command: 'git commit -m "x"' }, workspace);
    assert.equal(commit.allow, false);
    assert.equal(commit.errorCode, 'COMPOSE_GIT_MANAGED');
    const push = await controller.check('run_command', { command: 'git push origin develop' }, workspace);
    assert.equal(push.allow, false);
    assert.equal(push.errorCode, 'COMPOSE_GIT_MANAGED');
  } finally {
    await cleanup();
  }
});

test('compose still allows run_command git reads and normal verification in its worktree', async () => {
  const { controller, workspace, cleanup } = await activeComposeInWorktree();
  try {
    assert.equal((await controller.check('run_command', { command: 'git status' }, workspace)).allow, true);
    assert.equal((await controller.check('run_command', { command: 'npm test' }, workspace)).allow, true);
  } finally {
    await cleanup();
  }
});

test('inactive compose leaves run_command git alone', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-compose-idle-'));
  try {
    const controller = new ComposeController(root);
    await controller.init();
    assert.equal(controller.isActive(), false);
    const decision = await controller.check('run_command', { command: 'git commit -m "x"' }, new Workspace(root));
    assert.equal(decision.allow, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
