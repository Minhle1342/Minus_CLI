import test from 'node:test';
import assert from 'node:assert';
import { ToolTransitionGraph } from './tool-transition-graph.js';
import { ToolRetriever } from './tool-retriever.js';
import { StepRetrievalQueryBuilder } from '../agent/step-retrieval-query-builder.js';
import type { ToolDefinition } from './types.js';

const mockTools: ToolDefinition[] = [
  { name: 'read_file', description: 'Read file contents', parameters: { type: 'object', properties: {} }, execute: async () => ({}) },
  { name: 'list_files', description: 'List files in directory', parameters: { type: 'object', properties: {} }, execute: async () => ({}) },
  { name: 'search_codebase_fast', description: 'Search codebase fast', parameters: { type: 'object', properties: {} }, execute: async () => ({}) },
  { name: 'search_text', description: 'Search text in files', parameters: { type: 'object', properties: {} }, execute: async () => ({}) },
  { name: 'apply_patch', description: 'Apply diff patch to file', parameters: { type: 'object', properties: {} }, execute: async () => ({}) },
  { name: 'replace_text', description: 'Replace exact text chunk in file', parameters: { type: 'object', properties: {} }, execute: async () => ({}) },
  { name: 'run_command', description: 'Execute shell command', parameters: { type: 'object', properties: {} }, execute: async () => ({}) },
  { name: 'submit_solution', description: 'Submit verified solution', parameters: { type: 'object', properties: {} }, execute: async () => ({}) },
  { name: 'get_diagnostics', description: 'Get compiler and type diagnostics', parameters: { type: 'object', properties: {} }, execute: async () => ({}) },
  { name: 'get_symbol_context_360', description: 'Get 360 degree symbol context callers callees tests', parameters: { type: 'object', properties: {} }, execute: async () => ({}) },
  { name: 'query_call_graph', description: 'Query call graph callers callees hierarchy', parameters: { type: 'object', properties: {} }, execute: async () => ({}) },
  { name: 'inspect_symbol', description: 'Inspect symbol definition', parameters: { type: 'object', properties: {} }, execute: async () => ({}) },
  { name: 'analyze_impact', description: 'Analyze blast radius and impact of symbol', parameters: { type: 'object', properties: {} }, execute: async () => ({}) },
  { name: 'read_shared_context', description: 'Read shared memory state with OCC version', parameters: { type: 'object', properties: {} }, execute: async () => ({}) },
  { name: 'write_shared_context', description: 'Write shared memory state with OCC versionHash', parameters: { type: 'object', properties: {} }, execute: async () => ({}) },
];

test('ToolTransitionGraph - Correctly evaluates outcome and assigns Markov prior boosts', () => {
  const graph = new ToolTransitionGraph();

  // 1. Sau khi mutation thành công -> get_diagnostics và run_command phải được ưu tiên cao nhất
  const boostDiagnostics = graph.getTransitionBoost('apply_patch', { success: true, diff: '...' }, 'get_diagnostics');
  const boostRunCommand = graph.getTransitionBoost('apply_patch', { success: true }, 'run_command');
  const boostReadFile = graph.getTransitionBoost('apply_patch', { success: true }, 'read_file');
  assert.ok(boostDiagnostics > 0.2, 'get_diagnostics phải có boost > 0.2 sau mutation thành công');
  assert.ok(boostRunCommand > 0.2, 'run_command phải có boost > 0.2 sau mutation thành công');
  assert.strictEqual(boostReadFile, 0, 'read_file không phải primary successor của mutation thành công');

  // 2. Sau khi mutation thất bại -> read_file và replace_text phải được ưu tiên
  const boostRetryRead = graph.getTransitionBoost('apply_patch', { error: 'Hunk #1 failed' }, 'read_file');
  const boostRetryReplace = graph.getTransitionBoost('apply_patch', { status: 'FUZZY_CANDIDATE_FOUND' }, 'replace_text');
  assert.ok(boostRetryRead > 0.2, 'read_file phải được boost sau patch failure');
  assert.ok(boostRetryReplace > 0.2, 'replace_text phải được boost sau patch failure');

  // 3. Sau khi get_diagnostics clean (0 lỗi) -> submit_solution được boost mạnh
  const boostSubmit = graph.getTransitionBoost('get_diagnostics', { clean: true, totalErrors: 0 }, 'submit_solution');
  assert.ok(boostSubmit >= 0.3, 'submit_solution phải có prior boost >= 0.3 khi diagnostics clean');

  // 4. Sau khi run_command test pass -> submit_solution được boost
  const boostTestPass = graph.getTransitionBoost('run_command', { command: 'npm test', exitCode: 0 }, 'submit_solution');
  assert.ok(boostTestPass >= 0.3, 'submit_solution phải có prior boost khi test pass');
});

test('ToolRetriever - Supports structured StepRetrievalQueryResult and Graph-Augmented RRF', () => {
  const retriever = new ToolRetriever({ enabled: true, activationThreshold: 5, topK: 3 });
  retriever.indexTools(mockTools);

  const queryBuilder = new StepRetrievalQueryBuilder();
  const stepResult = queryBuilder.build({
    userRequest: 'Fix type error in authentication token parser',
    activeTask: {
      title: 'Fix token parser',
      readSet: ['src/auth/token.ts'],
      symbols: ['TokenParser'],
    },
    phase: 'implement',
    taskClass: 'bugfix',
    lastToolName: 'apply_patch',
    lastToolResult: { success: true, mutatedFile: 'src/auth/token.ts' },
    allowedToolNames: mockTools.map((t) => t.name),
  });

  // Gọi retrieve với structured query object
  const declarations = retriever.retrieve(stepResult, mockTools);
  const names = declarations.map((d) => d.name);

  // Phải giữ vững Anchor Tools và chọn get_diagnostics / run_command / get_symbol_context_360
  assert.ok(names.includes('read_file'), 'Anchor read_file phải có mặt');
  assert.ok(names.includes('apply_patch'), 'Anchor apply_patch phải có mặt');
  assert.ok(names.includes('get_diagnostics'), 'get_diagnostics phải được chọn do Graph boost sau mutation');
});

test('ToolRetriever - Generates Two-Tier compact catalog stubs', () => {
  const retriever = new ToolRetriever();
  retriever.indexTools(mockTools);

  const stubs = retriever.getToolCatalogStubs(mockTools);
  assert.strictEqual(stubs.length, mockTools.length, 'Số lượng stubs phải khớp số lượng tools');
  assert.ok(stubs.some((s) => s.name === 'get_diagnostics' && s.category === 'code_intelligence'));
  assert.ok(stubs.some((s) => s.name === 'run_command' && s.category === 'process_task'));
});
