import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolUseGuardian } from '../tools/tool-use-guardian.js';
import { EDIT_TOOL_NAMES } from '../control/tool-descriptor-registry.js';
import { generateWarmStartTopology } from './warm-start-topomap.js';

test('Mechanism 1 (Pre-Mutation Inspection Barrier): blocks mutation when target is not inspected in evidence-controlled task', () => {
  const guardian = new ToolUseGuardian({ workspaceDir: process.cwd() });

  // Uninspected target in bugfix task
  guardian.setPreMutationGateContext({
    isBugfixTask: true,
    taskClass: 'bugfix',
    phase: 'implement',
    hasPlan: true,
    hasValidatedHypothesis: false,
    inspectedFiles: [], // Empty inspection
  });

  const blocked = guardian.preCallValidate('replace_text', {
    path: 'src/core.ts',
    oldText: 'const a = 1;',
    newText: 'const a = 2;',
  });

  assert.equal(blocked.valid, false, 'Mutating uninspected file must be blocked');
  assert.equal(blocked.errorCode, 'UNVERIFIED_MUTATION_BLOCKED');
  assert.equal(blocked.suggestedTool, 'read_file');
  assert.equal(blocked.guardianDiagnosis?.category, 'PRE_MUTATION_GATE_BLOCKED');
  assert.match(blocked.guardianDiagnosis?.recoveryAction || '', /read_file/i);
});

test('Mechanism 1 (Pre-Mutation Inspection Barrier): allows mutation when target has been inspected', () => {
  const guardian = new ToolUseGuardian({ workspaceDir: process.cwd() });

  guardian.setPreMutationGateContext({
    isBugfixTask: true,
    taskClass: 'bugfix',
    phase: 'implement',
    hasPlan: true,
    hasValidatedHypothesis: false,
    risk: 'R2',
    evidenceScore: 3,
    evidenceThreshold: 3,
    inspectedFiles: ['src/core.ts'], // Target inspected
  });

  const allowed = guardian.preCallValidate('replace_text', {
    path: 'src/core.ts',
    oldText: 'const a = 1;',
    newText: 'const a = 2;',
  });

  assert.equal(allowed.valid, true, 'Inspected target must be allowed to mutate');
});

test('Mechanism 1 (TDD Fast-Pass): allows creating test and scratch files without prior inspection', () => {
  const guardian = new ToolUseGuardian({ workspaceDir: process.cwd() });

  guardian.setPreMutationGateContext({
    isBugfixTask: true,
    taskClass: 'bugfix',
    phase: 'explore',
    hasPlan: false,
    hasValidatedHypothesis: false,
    inspectedFiles: [],
  });

  const testFile = guardian.preCallValidate('write_file', {
    path: 'tests/unit/repro.test.ts',
    content: 'test',
  });
  assert.equal(testFile.valid, true, 'Test files are exempt from pre-mutation inspection barrier');

  const scratchFile = guardian.preCallValidate('write_file', {
    path: 'scratch/repro.ts',
    content: 'scratch',
  });
  assert.equal(scratchFile.valid, true, 'Scratch files are exempt from pre-mutation inspection barrier');
});

test('Mechanism 2 (Strict Phase Tool Masking): EDIT_TOOL_NAMES contains all mutating tools', () => {
  const expectedEditTools = [
    'replace_text',
    'apply_patch',
    'write_file',
    'create_file',
    'delete_file',
    'move_file',
    'write_to_file',
    'replace_file_content',
    'multi_replace_file_content',
  ];

  for (const tool of expectedEditTools) {
    assert.ok(EDIT_TOOL_NAMES.has(tool), `EDIT_TOOL_NAMES must include ${tool}`);
  }
});

test('Mechanism 2 (Strict Phase Tool Masking): masking filter strips all edit tools during explore phase', () => {
  const sampleTools = [
    { name: 'read_file' },
    { name: 'search_codebase_fast' },
    { name: 'replace_text' },
    { name: 'apply_patch' },
    { name: 'write_file' },
    { name: 'request_phase_transition' },
  ];

  const phase: string = 'explore';
  const filtered = ['explore', 'plan'].includes(phase)
    ? sampleTools.filter((t) => !EDIT_TOOL_NAMES.has(t.name))
    : sampleTools;

  assert.equal(filtered.length, 3);
  assert.deepEqual(filtered.map((t) => t.name), ['read_file', 'search_codebase_fast', 'request_phase_transition']);
  assert.ok(!filtered.some((t) => EDIT_TOOL_NAMES.has(t.name)));
});

test('Mechanism 3 (Warm-Start Topo-Map): extracts entities from user prompt and generates compact topology', async () => {
  const topo = await generateWarmStartTopology({
    workspaceRootDir: process.cwd(),
    userPrompt: 'Sửa lỗi trong AgentLoop và ToolRunner khi xử lý tool call',
    maxFiles: 3,
    maxTokens: 220,
  });

  assert.ok(topo.rendered.includes('[WORKSPACE TOPOLOGY WARM-START'), 'Must have topology header');
  assert.ok(topo.matchedFiles.length > 0, 'Must match at least one relevant file');
  assert.ok(topo.estimatedTokens <= 250, 'Must stay within token budget');
});
