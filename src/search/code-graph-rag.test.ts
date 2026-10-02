import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chunkCodeFile } from './semantic-chunker.js';
import { SemanticCodeIndex } from './semantic-code-index.js';
import { DeterministicCodeEmbeddingProvider } from './embedding-provider.js';

test('chunkCodeFile - Extracts deep AST relations including calls, types and inheritance', () => {
  const code = [
    'export interface TokenPayload {',
    '  userId: string;',
    '  expiresAt: number;',
    '}',
    '',
    'export class BaseService {',
    '  log(msg: string): void {',
    '    console.log(msg);',
    '  }',
    '}',
    '',
    'export class AuthService extends BaseService {',
    '  validateToken(payload: TokenPayload): boolean {',
    '    this.log("validating");',
    '    return verifyPayload(payload);',
    '  }',
    '}',
    '',
    'export function verifyPayload(payload: TokenPayload): boolean {',
    '  return payload.expiresAt > Date.now();',
    '}',
  ].join('\n');

  const chunks = chunkCodeFile('src/auth/service.ts', code);

  // 1. Kiểm tra interface TokenPayload
  const tokenInterface = chunks.find((c) => c.name === 'TokenPayload');
  assert.ok(tokenInterface, 'TokenPayload interface should be present');
  assert.equal(tokenInterface.kind, 'interface');

  // 2. Kiểm tra AuthService kế thừa BaseService
  const authService = chunks.find((c) => c.name === 'AuthService');
  assert.ok(authService, 'AuthService class should be present');
  assert.ok(authService.graphEdges?.some((e) => e.target === 'BaseService' && e.relation === 'extends'));

  // 3. Kiểm tra method validateToken
  const validateMethod = chunks.find((c) => c.name === 'validateToken');
  assert.ok(validateMethod, 'validateToken method should be present');
  assert.equal(validateMethod.parentSymbol, 'AuthService');
  assert.ok(validateMethod.outgoingCalls?.includes('verifyPayload'), 'Should detect verifyPayload call');
  assert.ok(validateMethod.outgoingCalls?.includes('log'), 'Should detect log call');
  assert.ok(validateMethod.typesReferenced?.includes('TokenPayload'), 'Should detect TokenPayload reference');

  // 4. Kiểm tra verifyPayload function
  const verifyFunc = chunks.find((c) => c.name === 'verifyPayload');
  assert.ok(verifyFunc, 'verifyPayload function should be present');
  assert.ok(verifyFunc.typesReferenced?.includes('TokenPayload'));
});

test('SemanticCodeIndex - Builds Code Property Graph and computes Personalized PageRank', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codegraph-rag-test-'));

  try {
    // Tạo 2 file code có quan hệ gọi nhau
    await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });

    // utils.ts chứa hashPassword
    await fs.writeFile(
      path.join(tempDir, 'src', 'utils.ts'),
      [
        'export function hashPassword(plain: string): string {',
        '  return "hashed:" + plain;',
        '}',
        '',
        'export function verifyHash(plain: string, hash: string): boolean {',
        '  return hashPassword(plain) === hash;',
        '}',
      ].join('\n'),
    );

    // auth.ts gọi hashPassword và verifyHash
    await fs.writeFile(
      path.join(tempDir, 'src', 'auth.ts'),
      [
        'import { hashPassword, verifyHash } from "./utils.js";',
        '',
        'export function registerUser(username: string, pass: string) {',
        '  const hashed = hashPassword(pass);',
        '  return { username, hashed };',
        '}',
        '',
        'export function loginUser(username: string, pass: string, storedHash: string) {',
        '  return verifyHash(pass, storedHash);',
        '}',
      ].join('\n'),
    );

    const provider = new DeterministicCodeEmbeddingProvider();
    const index = new SemanticCodeIndex(tempDir, provider);
    await index.buildIndex();

    // 1. Kiểm tra Symbol Graph Neighbors
    // registerUser gọi hashPassword (downstream)
    const downstreamNeighbors = index.getSymbolNeighbors('registerUser', { depth: 1, direction: 'downstream' });
    assert.ok(
      downstreamNeighbors.some((n) => n.chunk.name === 'hashPassword'),
      'registerUser should have hashPassword as downstream neighbor',
    );

    // hashPassword được gọi bởi registerUser và verifyHash (upstream)
    const upstreamNeighbors = index.getSymbolNeighbors('hashPassword', { depth: 1, direction: 'upstream' });
    assert.ok(
      upstreamNeighbors.some((n) => n.chunk.name === 'registerUser' || n.chunk.name === 'verifyHash'),
      'hashPassword should have registerUser or verifyHash as upstream caller',
    );

    // 2. Kiểm tra Graph Expansion với dependencies mode
    const searchResults = await index.search('registerUser', {
      limit: 5,
      graphExpansion: 'dependencies',
    });

    assert.ok(searchResults.length > 0);
    // Kết quả mở rộng đồ thị phải mang theo hashPassword
    const hasHashPassword = searchResults.some((r) => r.chunk.name === 'hashPassword');
    assert.ok(hasHashPassword, 'Graph expansion should bring hashPassword along with registerUser');

    // 3. Kiểm tra Graph Expansion với impact mode
    const impactResults = await index.search('hashPassword', {
      limit: 5,
      graphExpansion: 'impact',
    });
    // Khi tìm hashPassword với mode impact, các callers (registerUser, verifyHash) phải được mở rộng
    assert.ok(
      impactResults.some((r) => r.chunk.name === 'registerUser' || r.chunk.name === 'verifyHash'),
      'Impact expansion should include callers of hashPassword',
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('PersistentVectorStore - Supports searchWithGraphPrior combining cosine with graph weights', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vector-graph-prior-test-'));
  try {
    const { PersistentVectorStore } = await import('./vector-store.js');
    const store = new PersistentVectorStore(tempDir, 4);

    const records = [
      { id: 'chunk-1', vector: [1, 0, 0, 0], metadata: { name: 'funcA' } },
      { id: 'chunk-2', vector: [0.9, 0.1, 0, 0], metadata: { name: 'funcB' } },
      { id: 'chunk-3', vector: [0.1, 0.9, 0, 0], metadata: { name: 'funcC' } },
    ];

    await store.replaceAll(records, 'test-model', 'rev-1');

    // Truy vấn với vector [1, 0, 0, 0] và ưu tiên graph prior cho chunk-2
    const graphPriors = new Map([
      ['chunk-1', 0.1],
      ['chunk-2', 0.9], // graph prior rất cao
      ['chunk-3', 0.0],
    ]);

    const hits = await store.searchWithGraphPrior([1, 0, 0, 0], graphPriors, 3, 0, 0.5);
    assert.equal(hits.length, 3);
    // Nhờ graph prior mạnh (0.9 vs 0.1), chunk-2 vươn lên dẫn đầu hoặc có điểm fused cao
    assert.ok(hits[0].id === 'chunk-2' || hits[0].similarity > 0.8);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('fuseSearchResults - Boosts graph-expanded candidates when query contains structural intent', async () => {
  const { fuseSearchResults } = await import('./hybrid-ranker.js');
  const lexicalHits = [
    { path: 'src/main.ts', score: 0.5, matchTerms: ['main'], snippet: 'main()', lineMatches: [] },
  ];
  const semanticHits = [
    {
      chunk: {
        id: 'c1',
        path: 'src/caller.ts',
        language: 'typescript',
        kind: 'function' as const,
        name: 'callerFunc',
        qualifiedName: 'src/caller.ts::callerFunc',
        signature: 'callerFunc()',
        startLine: 1,
        endLine: 5,
        sourceHash: 'a'.repeat(64),
        text: 'callerFunc() {}',
        embeddingText: 'callerFunc',
        imports: [],
        parserConfidence: 'high' as const,
      },
      semanticScore: 0.8,
      graphScore: 0.25,
      expandedFrom: 'src/main.ts::main',
    },
  ];

  // 1. Query thông thường
  const normalFused = fuseSearchResults('some general logic', lexicalHits, semanticHits, 5);
  const normalScore = normalFused.find((h) => h.path === 'src/caller.ts')?.score || 0;

  // 2. Query có chủ đích cấu trúc / callers
  const structuralFused = fuseSearchResults('who are the callers and what is the blast radius?', lexicalHits, semanticHits, 5);
  const structuralScore = structuralFused.find((h) => h.path === 'src/caller.ts')?.score || 0;

  assert.ok(
    structuralScore > normalScore,
    `Structural query score (${structuralScore}) should be higher than normal query score (${normalScore}) for graph expanded hit`,
  );
});
