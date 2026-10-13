import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRegistry } from './registry.js';
import { Workspace } from '../workspace/workspace.js';
import { registerWorktreeTools } from './worktree-tools.js';
import { ToolDescriptorRegistry } from '../control/tool-descriptor-registry.js';

const dummy = { name: '', description: '', parameters: {}, execute: async () => ({}) } as any;

test('worktree tools register once with approval required for mutations', () => {
  const registry = new ToolRegistry();
  const workspace = new Workspace(process.cwd());
  registerWorktreeTools(registry, workspace);
  registerWorktreeTools(registry, workspace);
  for (const name of ['create_worktree', 'list_worktrees', 'remove_worktree']) {
    assert.ok(registry.has(name), `${name} must be registered`);
  }
  const descriptors = new ToolDescriptorRegistry();
  assert.equal(descriptors.describe({ ...dummy, name: 'list_worktrees' }).requiresApproval, false);
  assert.equal(descriptors.describe({ ...dummy, name: 'create_worktree' }).requiresApproval, true);
  assert.equal(descriptors.describe({ ...dummy, name: 'remove_worktree' }).requiresApproval, true);
});
