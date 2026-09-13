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

test('ToolRetriever keeps a workflow-complete core and prunes unrelated network and memory schemas', () => {
  const registry = new ToolRegistry();
  assert.deepEqual(registry.getRetriever().getConfig().alwaysInclude, [
    'read_file',
    'list_files',
    'search_codebase_fast',
    'apply_patch',
    'replace_text',
    'run_command',
    'submit_solution',
  ]);

  const codingTools = registry.getRelevantTools('fix the failing parser unit test');
  const codingNames = new Set(codingTools.map((tool) => tool.name));
  assert.equal(codingNames.has('web_search'), false);
  assert.equal(codingNames.has('web_fetch'), false);
  assert.equal(codingNames.has('read_memory'), false);
  assert.equal(codingNames.has('apply_patch'), true);
  assert.equal(codingNames.has('replace_text'), true);
  assert.ok(codingTools.length <= 14, `expected at most 14 schemas, received ${codingTools.length}`);

  const webNames = new Set(registry.getRelevantTools('research the latest Node.js documentation online').map((tool) => tool.name));
  assert.equal(webNames.has('web_search'), true);
  assert.equal(webNames.has('web_fetch'), true);
  assert.equal(webNames.has('search_web'), false);
  assert.equal(webNames.has('read_url_content'), false);
});
