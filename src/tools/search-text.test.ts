import test from 'node:test';
import assert from 'node:assert/strict';
import { searchTextTool } from './search-text.js';
import { ToolRegistry } from './registry.js';
import { Workspace } from '../workspace/workspace.js';

test('searchTextTool - Regex Search in codebase', async () => {
  const workspace = new Workspace(process.cwd());
  const res = await searchTextTool.execute(
    {
      query: 'export\\s+const\\s+searchTextTool',
      path: 'src/tools/search-text.ts',
      isRegex: true,
    },
    workspace
  );

  assert.equal(res.totalMatches > 0, true, 'Should find at least 1 match for searchTextTool');
  assert.equal(res.matches.length > 0, true, 'Matches array should not be empty');
  assert.ok(res.content.includes('export const searchTextTool: ToolDefinition'), 'Should return exact matched declaration line');
  assert.ok(res.content.includes('src/tools/search-text.ts:'), 'Formatted content should have path:line: text structure');
});

test('searchTextTool - Include Glob Filter', async () => {
  const workspace = new Workspace(process.cwd());
  // Tìm kiếm từ khóa "scripts" chỉ trong các file *.json
  const res = await searchTextTool.execute(
    {
      query: 'scripts',
      path: '.',
      include: '*.json',
      outputMode: 'files_with_matches',
    },
    workspace
  );

  assert.equal(res.outputMode, 'files_with_matches', 'Should respect outputMode');
  assert.ok(Array.isArray(res.files), 'Should return files array');
  assert.ok(res.files.some((f: string) => f.endsWith('package.json')), 'Should find package.json');
  // Không được chứa file .ts
  assert.ok(res.files.every((f: string) => !f.endsWith('.ts')), 'Should only match json files per glob filter');
});

test('searchTextTool - OutputMode Count', async () => {
  const workspace = new Workspace(process.cwd());
  const res = await searchTextTool.execute(
    {
      query: 'Workspace',
      path: 'src/tools/search-text.ts',
      outputMode: 'count',
    },
    workspace
  );

  assert.equal(res.outputMode, 'count', 'Output mode should be count');
  assert.equal(typeof res.totalMatches, 'number', 'totalMatches should be a number');
  assert.ok(res.totalMatches >= 1, 'Should count at least 1 occurrence of Workspace');
});

test('searchTextTool - Context Window Protection & maxMatches Capping', async () => {
  const workspace = new Workspace(process.cwd());
  const maxLimit = 3;
  const res = await searchTextTool.execute(
    {
      query: 'import',
      path: 'src/tools',
      maxMatches: maxLimit,
      outputMode: 'content',
    },
    workspace
  );

  assert.ok(res.matches.length <= maxLimit, `Matches count should be capped at ${maxLimit}`);
  assert.equal(res.isCapped, true, 'isCapped flag should be true');
  assert.ok(res.warning?.includes('[SEARCH_CAPPED]'), 'Should contain context warning');
  assert.ok(Boolean(res.suggestion), 'Should provide suggestion to refine regex or path');
});

test('ToolRegistry - searchTextTool is registered and retrievable', () => {
  const registry = new ToolRegistry();
  const tool = registry.get('search_text');

  assert.ok(tool !== undefined, 'search_text should be registered in ToolRegistry');
  assert.equal(tool?.name, 'search_text', 'Tool name should match');
  assert.ok((tool?.parameters as any)?.properties?.query, 'Tool schema should have query property');
  assert.ok((tool?.parameters as any)?.properties?.isRegex, 'Tool schema should have isRegex property');
  assert.ok((tool?.parameters as any)?.properties?.include, 'Tool schema should have include property');
});
