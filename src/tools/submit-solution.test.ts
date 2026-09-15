import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubmitSolutionTool, registerSubmitSolutionTool } from './submit-solution.js';
import { ToolRegistry } from './registry.js';
import { Workspace } from '../workspace/workspace.js';

test('submit_solution: schema exposes summary as required and verificationEvidence as optional', () => {
  const workspace = new Workspace();
  const tool = createSubmitSolutionTool(workspace);

  assert.equal(tool.name, 'submit_solution');
  assert.equal(tool.parameters?.type, 'OBJECT');
  assert.ok(tool.parameters?.properties?.summary, 'summary property should exist');
  assert.ok(tool.parameters?.properties?.verificationEvidence, 'verificationEvidence property should exist');

  // Verify verificationEvidence is optional (commit 789183f)
  assert.deepEqual(tool.parameters?.required, ['summary']);
  assert.equal(tool.parameters?.required?.includes('verificationEvidence'), false);
});

test('submit_solution: executes successfully when verificationEvidence is omitted (defaults safely)', async () => {
  const workspace = new Workspace();
  const tool = createSubmitSolutionTool(workspace);

  const result = await tool.execute({
    summary: 'Updated command-preflight-guard.ts type definitions and validated with unit test suite.',
    filesModified: ['src/tools/command-preflight-guard.ts'],
  }, workspace);

  assert.equal(result.success, true);
  assert.equal(result.submitted, true);
  assert.equal(result.verificationEvidence, 'Verified via inspection and direct validation');
  assert.deepEqual(result.filesModified, ['src/tools/command-preflight-guard.ts']);
  assert.equal(result.nextAction, 'final_answer');
});

test('submit_solution: executes successfully when verificationEvidence is provided', async () => {
  const workspace = new Workspace();
  const tool = createSubmitSolutionTool(workspace);

  const result = await tool.execute({
    summary: 'Implemented feature fix and ran verification.',
    verificationEvidence: 'npm test -- --filter=preflight passed with exit code 0',
    filesModified: ['src/tools/command-preflight-guard.ts'],
    rootCause: 'Missing workspaceRoot property in options type',
  }, workspace);

  assert.equal(result.success, true);
  assert.equal(result.submitted, true);
  assert.equal(result.verificationEvidence, 'npm test -- --filter=preflight passed with exit code 0');
  assert.equal(result.rootCause, 'Missing workspaceRoot property in options type');
});

test('submit_solution: rejects empty summary', async () => {
  const workspace = new Workspace();
  const tool = createSubmitSolutionTool(workspace);

  await assert.rejects(
    async () => {
      await tool.execute({ summary: '   ' }, workspace);
    },
    /Missing required argument: "summary" cannot be empty/
  );
});

test('submit_solution: Tool-Use Guardian rejects pseudo-claims without concrete findings', async () => {
  const workspace = new Workspace();
  const tool = createSubmitSolutionTool(workspace);

  const res = await tool.execute({
    summary: 'Đã cung cấp câu trả lời chi tiết và đầy đủ cho người dùng.',
  }, workspace);

  assert.equal(res.success, false);
  assert.equal(res.submitted, false);
  assert.equal(res.errorCode, 'INVALID_SUMMARY_CONTENT');
});

test('submit_solution: registers cleanly into ToolRegistry', () => {
  const registry = new ToolRegistry();
  const workspace = new Workspace();
  registerSubmitSolutionTool(registry, workspace);

  assert.ok(registry.has('submit_solution'));
  const tool = registry.get('submit_solution');
  assert.equal(tool?.name, 'submit_solution');
});
