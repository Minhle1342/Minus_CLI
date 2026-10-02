import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalCrossEncoderReranker } from './reranker.js';
import { ToolRetriever } from './tool-retriever.js';
import type { ToolDefinition } from './types.js';

const mockToolDefinitions: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file from the filesystem',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to file' },
        line_offset: { type: 'number', description: 'Starting line' },
      },
    } as any,
    execute: async () => ({}),
  },
  {
    name: 'apply_patch',
    description: 'Apply git unified diff format patch to modify or edit source files',
    parameters: {
      type: 'object',
      properties: {
        patch: { type: 'string', description: 'Diff content with hunks' },
      },
    } as any,
    execute: async () => ({}),
  },
  {
    name: 'get_diagnostics',
    description: 'Retrieve compiler, linter, and typechecker diagnostics errors and warnings',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path to source file' },
      },
    } as any,
    execute: async () => ({}),
  },
  {
    name: 'query_call_graph',
    description: 'Query function callers, callees, and call hierarchy tree',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Target symbol name' },
        direction: { type: 'string', description: 'callers or callees' },
      },
    } as any,
    execute: async () => ({}),
  },
  {
    name: 'web_search',
    description: 'Search online documentation and internet resources with query terms',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords' },
      },
    } as any,
    execute: async () => ({}),
  },
  {
    name: 'create_plan',
    description: 'Create and initialize a multi-step task execution roadmap milestone plan',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Plan title' },
        steps: { type: 'array', description: 'Ordered milestone steps' },
      },
    } as any,
    execute: async () => ({}),
  },
  {
    name: 'remember_memory',
    description: 'Store and remember key episodic lesson or insight into long-term memory',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Memory knowledge fact' },
      },
    } as any,
    execute: async () => ({}),
  },
];

test('LocalCrossEncoderReranker - Returns baseline rankings when query or candidates are empty', () => {
  const reranker = new LocalCrossEncoderReranker();

  const emptyResults = reranker.rerank('', mockToolDefinitions);
  assert.equal(emptyResults.length, 5);
  assert.equal(emptyResults[0].score, 1.0);

  const noCandidates = reranker.rerank('test query', []);
  assert.equal(noCandidates.length, 0);
});

test('LocalCrossEncoderReranker - Rewards exact and subword tool name matches', () => {
  const reranker = new LocalCrossEncoderReranker();

  const results = reranker.rerank('use get_diagnostics to check compiler issues', mockToolDefinitions);
  assert.ok(results.length > 0);
  assert.equal(results[0].tool.name, 'get_diagnostics', 'get_diagnostics should be top ranked');
  assert.ok(results[0].lexicalScore > 3.0, 'Exact name match should provide strong lexical score');
  assert.ok(results[0].reasons.some((r) => r.includes('Tool name exact/subword match')));
});

test('LocalCrossEncoderReranker - Rewards parameter keyword alignment', () => {
  const reranker = new LocalCrossEncoderReranker();

  // Query specifying parameter name 'line_offset'
  const results = reranker.rerank('inspect line_offset in file', mockToolDefinitions);
  assert.ok(results.length > 0);
  assert.equal(results[0].tool.name, 'read_file');
  assert.ok(results[0].reasons.some((r) => r.includes('Parameter keyword alignment')));
});

test('LocalCrossEncoderReranker - Boosts appropriate tools based on task intent', () => {
  const reranker = new LocalCrossEncoderReranker();

  // 1. Mutation intent -> apply_patch
  const patchResults = reranker.rerank('patch and fix the syntax bug in auth.ts', mockToolDefinitions);
  assert.equal(patchResults[0].tool.name, 'apply_patch');
  assert.ok(patchResults[0].intentBoost > 0);

  // 2. Code intelligence intent -> query_call_graph
  const graphResults = reranker.rerank('who are the callers and callees in the call graph?', mockToolDefinitions);
  assert.equal(graphResults[0].tool.name, 'query_call_graph');
  assert.ok(graphResults[0].intentBoost > 0);

  // 3. Web research intent -> web_search
  const webResults = reranker.rerank('search online documentation for v8 changes', mockToolDefinitions);
  assert.equal(webResults[0].tool.name, 'web_search');
  assert.ok(webResults[0].intentBoost > 0);

  // 4. Planning intent -> create_plan
  const planResults = reranker.rerank('create milestone roadmap and plan for next release', mockToolDefinitions);
  assert.equal(planResults[0].tool.name, 'create_plan');
  assert.ok(planResults[0].intentBoost > 0);
});

test('LocalCrossEncoderReranker - Dynamically applies adaptive cutoff ratio to prune noise', () => {
  const reranker = new LocalCrossEncoderReranker();

  // Highly specific query that matches one tool strongly and leaves others far behind
  const results = reranker.rerank('query function callers in call hierarchy', mockToolDefinitions, {
    topK: 5,
    minScore: 0.05,
    adaptiveCutoffRatio: 0.35,
  });

  // Tools that have virtually 0 overlap should be pruned
  assert.ok(results.length <= 4, `Adaptive truncation should prune low-relevance tools, got ${results.length}`);
  assert.equal(results[0].tool.name, 'query_call_graph');
  const hasWebSearch = results.some((r) => r.tool.name === 'web_search');
  assert.equal(hasWebSearch, false, 'Completely unrelated tools should be pruned by adaptive cutoff');
});

test('ToolRetriever exposes LocalCrossEncoderReranker via getter', () => {
  const retriever = new ToolRetriever();
  const reranker = retriever.getReranker();
  assert.ok(reranker instanceof LocalCrossEncoderReranker);
});
