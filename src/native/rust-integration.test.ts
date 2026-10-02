import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Type } from '@google/genai';
import { getNativeCore } from './index.js';
import { batchSubwordSimilarity } from './semantic-batch.js';
import { SemanticCodeIndex } from '../search/semantic-code-index.js';
import { DeterministicCodeEmbeddingProvider } from '../search/embedding-provider.js';
import { chunkCodeFile } from '../search/semantic-chunker.js';
import { SemanticSlicer } from '../agent/semantic-slicer.js';
import { LocalCrossEncoderReranker } from '../tools/reranker.js';
import type { ToolDefinition } from '../tools/types.js';

const native = getNativeCore();

test('native batch similarity matches individual native calls and preserves order', {
  skip: !native?.rsBatchSubwordSimilarity,
}, () => {
  const documents = ['read_file path', 'apply_patch diff', 'query_call_graph symbol'];
  const batch = batchSubwordSimilarity('find symbol', documents);
  assert.equal(batch?.length, documents.length);
  const queryVector = native!.rsGenerateSubwordEmbedding('find symbol');
  documents.forEach((document, index) => {
    const expected = native!.rsCosineSimilarity(queryVector, native!.rsGenerateSubwordEmbedding(document));
    assert.ok(Math.abs(batch![index] - expected) < 1e-9);
  });
});

test('native Rust parser supplies symbol spans, calls and trait implementation', {
  skip: !native?.rsParseRustCode,
}, () => {
  const source = [
    'use crate::crypto::hash;',
    'trait Runner { fn run(&self); }',
    'struct Service;',
    'impl Runner for Service {',
    '  fn run(&self) { hash(1); }',
    '}',
  ].join('\n');
  const chunks = chunkCodeFile('src/service.rs', source);
  const method = chunks.find((chunk) => chunk.qualifiedName === 'src/service.rs::Service.run');
  assert.equal(method?.startLine, 5);
  assert.ok(method?.outgoingCalls?.includes('hash'));
  assert.equal(method?.parserConfidence, 'high');
  assert.ok(chunks.find((chunk) => chunk.name === 'Service')?.graphEdges?.some((edge) =>
    edge.target === 'Runner' && edge.relation === 'implements'));
  assert.ok(method?.imports.includes('crate::crypto::hash'));
});

test('native graph expansion agrees with TypeScript reference across directions', {
  skip: !native?.RsCodeGraph,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-rust-graph-'));
  try {
    await fs.writeFile(path.join(root, 'graph.ts'), [
      'export function first() { second(); }',
      'export function second() { third(); }',
      'export function third() { return 1; }',
    ].join('\n'));
    const index = new SemanticCodeIndex(root, new DeterministicCodeEmbeddingProvider());
    await index.buildIndex();
    for (const mode of ['dependencies', 'impact', 'auto'] as const) {
      const actual = await index.search('first second third', { limit: 3, graphExpansion: mode });
      process.env.MINUS_DISABLE_NATIVE_GRAPH = '1';
      const expected = await index.search('first second third', { limit: 3, graphExpansion: mode });
      delete process.env.MINUS_DISABLE_NATIVE_GRAPH;
      assert.deepEqual(actual, expected);
    }
  } finally {
    delete process.env.MINUS_DISABLE_NATIVE_GRAPH;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Rust use path resolves a duplicate symbol to the imported module', {
  skip: !native?.rsParseRustCode,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-rust-import-'));
  try {
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'crypto.rs'), 'pub fn hash(value: i32) -> i32 { value + 1 }');
    await fs.writeFile(path.join(root, 'src', 'other.rs'), 'pub fn hash(value: i32) -> i32 { value - 1 }');
    await fs.writeFile(path.join(root, 'src', 'service.rs'), [
      'use crate::crypto::hash;',
      'pub fn run(value: i32) -> i32 { hash(value) }',
    ].join('\n'));
    const index = new SemanticCodeIndex(root, new DeterministicCodeEmbeddingProvider());
    await index.buildIndex();
    const neighbors = index.getSymbolNeighbors('run', { depth: 1, direction: 'downstream' });
    assert.ok(neighbors.some((neighbor) => neighbor.chunk.path === 'src/crypto.rs' && neighbor.chunk.name === 'hash'));
    assert.ok(!neighbors.some((neighbor) => neighbor.chunk.path === 'src/other.rs'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Rust mod paths distinguish qualified calls to duplicate symbols', {
  skip: !native?.rsParseRustCode,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-rust-mod-'));
  try {
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'crypto.rs'), 'pub fn hash() -> i32 { 1 }');
    await fs.writeFile(path.join(root, 'src', 'other.rs'), 'pub fn hash() -> i32 { 2 }');
    await fs.writeFile(path.join(root, 'src', 'lib.rs'), [
      'mod crypto;',
      'mod other;',
      'pub fn run() -> i32 { crypto::hash() + other::hash() }',
    ].join('\n'));
    const index = new SemanticCodeIndex(root, new DeterministicCodeEmbeddingProvider());
    await index.buildIndex();
    const neighbors = index.getSymbolNeighbors('run', { depth: 1, direction: 'downstream' });
    assert.deepEqual(neighbors.filter((neighbor) => neighbor.chunk.name === 'hash')
      .map((neighbor) => neighbor.chunk.path).sort(), ['src/crypto.rs', 'src/other.rs']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Rust parser and reranker retain TypeScript fallbacks when native paths are disabled', () => {
  process.env.MINUS_DISABLE_NATIVE_RUST_PARSER = '1';
  process.env.MINUS_DISABLE_NATIVE_BATCH = '1';
  try {
    const outline = SemanticSlicer.extractOutline('src/service.rs', 'pub fn run() {}');
    assert.equal(outline.parser, 'heuristic');
    assert.equal(outline.confidence, 'low');
    const tools = [
      { name: 'read_file', description: 'Read a file', parameters: { type: Type.OBJECT, properties: {} }, execute: async () => ({}) },
      { name: 'apply_patch', description: 'Change a file', parameters: { type: Type.OBJECT, properties: {} }, execute: async () => ({}) },
    ] satisfies ToolDefinition[];
    const results = new LocalCrossEncoderReranker().rerank('read_file', tools);
    assert.equal(results[0].tool.name, 'read_file');
  } finally {
    delete process.env.MINUS_DISABLE_NATIVE_RUST_PARSER;
    delete process.env.MINUS_DISABLE_NATIVE_BATCH;
  }
});
