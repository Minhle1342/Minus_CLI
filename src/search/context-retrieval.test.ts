import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Workspace } from '../workspace/workspace.js';
import { createPackCodebaseTool, createReadCompressedCodeTool } from '../tools/repomix-tool.js';
import { createSearchCodebaseFastTool } from '../tools/search-code-tool.js';
import { createPromptCacheEnvelope } from '../llm/cache-envelope.js';
import { openAIPromptCacheFields, resolvePromptCacheCapabilities } from '../llm/provider-capabilities.js';
import { DeepseekLLM } from '../llm/deepseek.js';
import { AnthropicLLM } from '../llm/anthropic.js';
import { GeminiLLM } from '../llm/gemini.js';
import { Session } from '../session/session.js';
import { buildAdaptiveCodeBundle } from './adaptive-code-reader.js';
import { DeterministicCodeEmbeddingProvider } from './embedding-provider.js';
import { decideRetrievalMode, fuseSearchResults } from './hybrid-ranker.js';
import { chunkCodeFile } from './semantic-chunker.js';
import { PersistentVectorStore } from './vector-store.js';

test('semantic chunker emits symbol-level source with provenance', () => {
  const chunks = chunkCodeFile('src/token.ts', [
    'export class TokenService {',
    '  refreshToken(value: string): string {',
    '    return value + "-fresh";',
    '  }',
    '}',
  ].join('\n'));
  assert.ok(chunks.some((chunk) => chunk.name === 'TokenService'));
  assert.ok(chunks.some((chunk) => chunk.name === 'refreshToken'));
  assert.ok(chunks.every((chunk) => /^[a-f0-9]{64}$/.test(chunk.sourceHash)));
});

test('adaptive reader returns a full focus body and lower-fidelity neighbors in one bundle', () => {
  const content = [
    'export function target(value: number) {',
    '  return value * 2;',
    '}',
    '',
    'export function neighbor(value: number) {',
    '  return target(value) + 1;',
    '}',
  ].join('\n');
  const result = buildAdaptiveCodeBundle([{
    path: 'src/math.ts',
    content,
    compressedContent: 'export function target(value: number)\nexport function neighbor(value: number)',
  }], { focusSymbols: ['target'], maxTokens: 1_000 });
  const target = result.segments.find((segment) => segment.symbol === 'target');
  assert.equal(target?.fidelity, 'full');
  assert.match(target?.content || '', /return value \* 2/);
  assert.ok(result.segments.some((segment) => segment.fidelity === 'preview' || segment.fidelity === 'fold'));
  assert.deepEqual(result.unresolvedFocusSymbols, []);
});

test('selective retrieval keeps exact identifiers lexical and natural-language intent hybrid', () => {
  assert.equal(decideRetrievalMode('TokenService').mode, 'lexical');
  assert.equal(decideRetrievalMode('where is an expired session token refreshed').mode, 'hybrid');
});

test('hybrid fusion keeps only the strongest symbol per path to prevent context crowding', () => {
  const lexicalHits = [
    { path: 'src/target.ts', score: 1, matchTerms: ['target'], snippet: 'target', lineMatches: [] },
    { path: 'src/other.ts', score: 0.5, matchTerms: ['other'], snippet: 'other', lineMatches: [] },
  ];
  const semanticHits = ['first', 'second'].map((name, index) => ({
    chunk: {
      id: name,
      path: 'src/target.ts',
      language: 'typescript',
      kind: 'method' as const,
      name,
      qualifiedName: `src/target.ts::Target.${name}`,
      signature: `${name}()`,
      startLine: index + 1,
      endLine: index + 1,
      sourceHash: name.padEnd(64, '0'),
      text: `${name}() {}`,
      embeddingText: name,
      imports: [],
      parserConfidence: 'high' as const,
    },
    semanticScore: 1 - index * 0.1,
    graphScore: 0,
  }));
  const fused = fuseSearchResults('natural language target behavior', lexicalHits, semanticHits, 10);
  assert.equal(fused.filter((hit) => hit.path === 'src/target.ts').length, 1);
  assert.equal(fused.length, 2);
  assert.equal(fused[0]?.symbol, 'Target.first');
});

test('cache envelope is deterministic and its key ignores the dynamic T3 tail', () => {
  const base = [
    { id: 'core', tier: 'T0' as const, content: 'core\r\npolicy  ' },
    { id: 'repo', tier: 'T1' as const, content: 'repository map' },
  ];
  const left = createPromptCacheEnvelope([...base, { id: 'step', tier: 'T3', content: 'step one' }], {
    provider: 'openai', model: 'test-model', repositoryRevision: 'abc', toolSchemaVersion: 'v1',
  });
  const right = createPromptCacheEnvelope([...base, { id: 'step', tier: 'T3', content: 'step two' }], {
    provider: 'openai', model: 'test-model', repositoryRevision: 'abc', toolSchemaVersion: 'v1',
  });
  assert.equal(left.cacheKey, right.cacheKey);
  assert.notEqual(left.canonicalPrompt, right.canonicalPrompt);
  assert.equal(left.tiers[0]?.content, 'core\npolicy');
});

test('provider capability mapping avoids sending OpenAI cache fields to unknown gateways', () => {
  assert.equal(resolvePromptCacheCapabilities('https://api.deepseek.com').provider, 'deepseek');
  assert.deepEqual(openAIPromptCacheFields('https://gateway.example/v1', 'key', {}), {});
  const previous = process.env.MINUS_CACHE_ENVELOPE_V2;
  process.env.MINUS_CACHE_ENVELOPE_V2 = 'on';
  try {
    assert.deepEqual(
      openAIPromptCacheFields('https://api.openai.com/v1', 'key', { promptCacheRetention: '24h' }),
      { prompt_cache_key: 'key', prompt_cache_retention: '24h' },
    );
  } finally {
    process.env.MINUS_CACHE_ENVELOPE_V2 = previous;
  }
});

test('OpenAI adapter sends cache key and retention in the request body only when cache v2 is on', async (t) => {
  const previousFetch = globalThis.fetch;
  const previousMode = process.env.MINUS_CACHE_ENVELOPE_V2;
  let capturedBody: any;
  process.env.MINUS_CACHE_ENVELOPE_V2 = 'on';
  globalThis.fetch = async (_input, init) => {
    capturedBody = JSON.parse(String(init?.body || '{}'));
    return new Response('data: {"choices":[{"finish_reason":"stop","delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    process.env.MINUS_CACHE_ENVELOPE_V2 = previousMode;
  });
  const session = new Session('openai-cache-contract');
  session.addUserMessage('hello');
  const llm = new DeepseekLLM({ apiKey: 'test', modelName: 'gpt-4o', baseURL: 'https://api.openai.com/v1' });
  await llm.generateStream(session, [], undefined, { promptCacheRetention: '24h' });
  assert.match(capturedBody.prompt_cache_key, /^pc2_/);
  assert.equal(capturedBody.prompt_cache_retention, '24h');
});

test('Anthropic adapter maps long retention to the supported one-hour ephemeral breakpoint', async (t) => {
  const previousFetch = globalThis.fetch;
  const previousMode = process.env.MINUS_CACHE_ENVELOPE_V2;
  let capturedBody: any;
  process.env.MINUS_CACHE_ENVELOPE_V2 = 'on';
  globalThis.fetch = async (_input, init) => {
    capturedBody = JSON.parse(String(init?.body || '{}'));
    return new Response([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}',
      '',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
      '',
    ].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    process.env.MINUS_CACHE_ENVELOPE_V2 = previousMode;
  });
  const session = new Session('anthropic-cache-contract');
  session.addUserMessage('hello');
  const llm = new AnthropicLLM({ apiKey: 'test', modelName: 'claude-test', baseURL: 'https://api.anthropic.com/v1' });
  await llm.generateStream(session, [], undefined, { promptCacheRetention: '24h' });
  assert.deepEqual(capturedBody.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
});

test('Gemini explicit cache is opt-in and removes duplicate stable prefix fields from generation', async (t) => {
  const previousMode = process.env.MINUS_CACHE_ENVELOPE_V2;
  const previousGeminiMode = process.env.MINUS_GEMINI_EXPLICIT_CACHE;
  process.env.MINUS_CACHE_ENVELOPE_V2 = 'on';
  process.env.MINUS_GEMINI_EXPLICIT_CACHE = 'on';
  t.after(() => {
    process.env.MINUS_CACHE_ENVELOPE_V2 = previousMode;
    process.env.MINUS_GEMINI_EXPLICIT_CACHE = previousGeminiMode;
  });
  const llm = new GeminiLLM('test', 'gemini-2.5-flash');
  let capturedConfig: any;
  (llm as any).client.caches.create = async () => ({ name: 'cachedContents/test' });
  (llm as any).client.models.generateContentStream = async (request: any) => {
    capturedConfig = request.config;
    return {
      async *[Symbol.asyncIterator]() {
        yield { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'ok' }] } }] };
      },
    };
  };
  const session = new Session('gemini-cache-contract');
  session.addUserMessage('hello');
  await llm.generateStream(session, []);
  assert.equal(capturedConfig.cachedContent, 'cachedContents/test');
  assert.equal(capturedConfig.systemInstruction, undefined);
  assert.equal(capturedConfig.tools, undefined);
});

test('persistent vector store uses HNSW when available and preserves exact fallback data', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-vector-test-'));
  t.after(async () => fs.rm(temporary, { recursive: true, force: true }));
  const provider = new DeterministicCodeEmbeddingProvider();
  const texts = ['refresh expired authentication token', 'render user interface component'];
  const vectors = await provider.embedDocuments(texts.map((text, index) => ({ id: String(index), text })));
  const store = new PersistentVectorStore<{ text: string }>(temporary, provider.dimensions);
  await store.replaceAll([
    { id: 'auth', vector: vectors[0], metadata: { text: texts[0] } },
    { id: 'ui', vector: vectors[1], metadata: { text: texts[1] } },
  ], provider.modelId, 'revision-1');
  const query = await provider.embedQuery('authentication token refresh');
  const hits = await store.search(query, 1);
  assert.equal(hits[0]?.id, 'auth');
  assert.ok(['hnsw', 'exact'].includes(store.getDiagnostics().backend));
});

test('search tool can run hybrid retrieval and return an adaptive bundle', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-search-test-'));
  t.after(async () => fs.rm(temporary, { recursive: true, force: true }));
  await fs.mkdir(path.join(temporary, 'src'), { recursive: true });
  await fs.writeFile(path.join(temporary, 'src', 'token-service.ts'), [
    'export function refreshExpiredSessionToken(token: string) {',
    '  return token + "-renewed";',
    '}',
  ].join('\n'));
  await fs.writeFile(path.join(temporary, 'src', 'button.ts'), 'export const Button = () => "button";\n');
  const previous = process.env.MINUS_SEMANTIC_SEARCH;
  process.env.MINUS_SEMANTIC_SEARCH = 'on';
  t.after(() => { process.env.MINUS_SEMANTIC_SEARCH = previous; });
  const result = await createSearchCodebaseFastTool().execute({
    query: 'renew an expired session credential token',
    mode: 'hybrid',
    contextMode: 'adaptive_bundle',
    limit: 3,
  }, new Workspace(temporary));
  assert.equal(result.retrieval?.effectiveMode, 'hybrid');
  assert.ok(result.hits?.some((hit: any) => hit.path === 'src/token-service.ts'));
  assert.ok(result.contextBundle?.segments?.some((segment: any) => segment.fidelity === 'full'));
});

test('read_compressed_code adaptive mode remains a single tool call', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-adaptive-test-'));
  t.after(async () => fs.rm(temporary, { recursive: true, force: true }));
  await fs.mkdir(path.join(temporary, 'src'), { recursive: true });
  await fs.writeFile(path.join(temporary, 'src', 'sample.ts'), [
    'export function calculateTotal(values: number[]) {',
    '  return values.reduce((sum, value) => sum + value, 0);',
    '}',
  ].join('\n'));
  const result = await createReadCompressedCodeTool().execute({
    path: 'src/sample.ts',
    fidelity: 'adaptive',
    focusSymbols: ['calculateTotal'],
    maxTokens: 1_000,
  }, new Workspace(temporary));
  assert.equal(result.fidelity, 'adaptive');
  assert.ok(result.segments?.some((segment: any) => segment.fidelity === 'full' && /reduce/.test(segment.content)));
});

test('read_compressed_code does not treat the workspace as its output file', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-repomix-output-test-'));
  t.after(async () => fs.rm(temporary, { recursive: true, force: true }));
  await fs.mkdir(path.join(temporary, 'src'), { recursive: true });
  await fs.writeFile(path.join(temporary, 'src', 'sample.ts'), 'export const sample = 1;\n');
  await fs.writeFile(path.join(temporary, 'src', 'unrelated.ts'), 'export const unrelated = 2;\n');
  await fs.writeFile(path.join(temporary, 'repomix.config.json'), JSON.stringify({
    output: { filePath: 'configured-output.xml' },
    include: ['src/**'],
  }));

  const result = await createReadCompressedCodeTool().execute({
    path: 'src/sample.ts',
  }, new Workspace(temporary));

  assert.equal(result.error, undefined);
  assert.equal(result.totalFiles, 1);

  const packResult = await createPackCodebaseTool().execute({
    include: ['src/sample.ts'],
  }, new Workspace(temporary));
  assert.equal(packResult.error, undefined);
  await assert.rejects(fs.access(path.join(temporary, 'configured-output.xml')));
});
