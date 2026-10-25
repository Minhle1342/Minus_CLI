import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_HIDDEN_TOOL_NAMES, ToolRegistry } from './registry.js';

test('ToolRegistry keeps compatibility tools executable but hides their schemas from the model', () => {
  const registry = new ToolRegistry();
  const registered = new Set(registry.getAll().map((tool) => tool.name));
  const declared = new Set(registry.getFunctionDeclarations().map((tool) => tool.name));

  for (const name of MODEL_HIDDEN_TOOL_NAMES) {
    assert.equal(registered.has(name), true, `${name} should remain registered for compatibility`);
    assert.equal(registry.has(name), true, `${name} should remain executable`);
    assert.equal(declared.has(name), false, `${name} should not consume model schema budget`);
  }
});

test('ToolScope preserves the model exposure policy', () => {
  const registry = new ToolRegistry();
  const scope = registry.createScope('model-exposure-test');
  const declared = new Set(scope.getFunctionDeclarations().map((tool) => tool.name));

  for (const name of MODEL_HIDDEN_TOOL_NAMES) {
    assert.equal(declared.has(name), false, `${name} should remain hidden inside a scope`);
  }
});

test('ToolRetriever keeps a workflow-complete core with 8 essential tools', () => {
  const registry = new ToolRegistry();
  assert.deepEqual(registry.getRetriever().getConfig().alwaysInclude, [
    'read_file',
    'list_files',
    'search_text',
    'replace_text',
    'write_file',
    'run_command',
    'web_search',
    'web_fetch',
  ]);

  const codingTools = registry.getRelevantTools('fix the failing parser unit test');
  const codingNames = new Set(codingTools.map((tool) => tool.name));
  assert.equal(codingNames.has('replace_text'), true);
  assert.equal(codingNames.has('read_file'), true);
  assert.equal(codingNames.has('search_text'), true);
  assert.equal(codingNames.has('write_file'), true);
  assert.equal(codingNames.has('run_command'), true);
  assert.equal(codingNames.has('list_files'), true);
  assert.ok(codingTools.length <= 8, `expected at most 8 schemas, received ${codingTools.length}`);

  const webNames = new Set(registry.getRelevantTools('research the latest Node.js documentation online').map((tool) => tool.name));
  assert.equal(webNames.has('web_search'), true);
  assert.equal(webNames.has('web_fetch'), true);
  assert.equal(webNames.has('search_web'), false);
  assert.equal(webNames.has('read_url_content'), false);
});

test('orchestration tools are exposed to the model and retrieved on delegation intent', () => {
  const registry = new ToolRegistry();
  registry.register({ name: 'delegate_task', description: 'test', parameters: { type: 'OBJECT', properties: {} } as any, execute: async () => ({}) });
  registry.register({ name: 'spawn_agent', description: 'test', parameters: { type: 'OBJECT', properties: {} } as any, execute: async () => ({}) });
  registry.register({ name: 'schedule_dag_parallel', description: 'test', parameters: { type: 'OBJECT', properties: {} } as any, execute: async () => ({}) });

  const declared = new Set(registry.getFunctionDeclarations().map((tool) => tool.name));
  assert.equal(declared.has('delegate_task'), true);
  assert.equal(declared.has('spawn_agent'), true);
  assert.equal(declared.has('schedule_dag_parallel'), true);

  const names = new Set(registry.getRelevantTools('cho 3 agent chạy song song đi').map((tool) => tool.name));
  assert.equal(names.has('delegate_task'), true, 'delegation intent must surface delegate_task');
  assert.equal(names.has('spawn_agent'), true, 'delegation intent must surface spawn_agent');
  assert.equal(names.has('schedule_dag_parallel'), true, 'delegation intent must surface schedule_dag_parallel');
});
