import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TemporalKnowledgeGraph } from './temporal-knowledge-graph.js';
import { ProjectMemoryManager } from './project-memory.js';

test('TemporalKnowledgeGraph - Manages entities and creates bi-temporal relations', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tkg-test-'));
  const graphFile = path.join(tempDir, 'temporal-graph.json');

  try {
    const graph = new TemporalKnowledgeGraph(graphFile);
    await graph.init();

    // 1. Thêm entities
    const authService = graph.upsertEntity({
      id: 'comp_auth_service',
      name: 'AuthService',
      type: 'component',
      summary: 'Handles user token signing and authentication',
    });

    const jwtTech = graph.upsertEntity({
      id: 'tech_jwt',
      name: 'JSON Web Token',
      type: 'technology',
      summary: 'Stateless session tokens',
    });

    assert.equal(authService.id, 'comp_auth_service');
    assert.equal(jwtTech.id, 'tech_jwt');

    // 2. Tạo quan hệ Bi-Temporal
    const rel = graph.addRelation('comp_auth_service', 'tech_jwt', 'DEPENDS_ON', {
      confidence: 0.95,
      metadata: { reason: 'Token signing' },
    });

    assert.ok(rel.id);
    assert.equal(rel.sourceEntityId, 'comp_auth_service');
    assert.equal(rel.targetEntityId, 'tech_jwt');
    assert.equal(rel.relation, 'DEPENDS_ON');
    assert.ok(rel.validFrom);
    assert.ok(rel.transactionFrom);
    assert.equal(rel.validTo, undefined);
    assert.equal(rel.transactionTo, undefined);

    // 3. Kiểm tra neighbors
    const neighbors = graph.getEntityNeighbors('comp_auth_service', { direction: 'outgoing' });
    assert.equal(neighbors.length, 1);
    assert.equal(neighbors[0].entity.id, 'tech_jwt');
    assert.equal(neighbors[0].relation.relation, 'DEPENDS_ON');

    // 4. Lưu và tải lại từ đĩa
    await graph.save();

    const graphReloaded = new TemporalKnowledgeGraph(graphFile);
    await graphReloaded.init();
    assert.equal(graphReloaded.getAllEntities().length, 2);
    assert.equal(graphReloaded.getAllRelations().length, 1);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('TemporalKnowledgeGraph - Handles Time-Travel queries (Point-In-Time Snapshot)', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tkg-time-travel-'));
  const graphFile = path.join(tempDir, 'temporal-graph.json');

  try {
    const graph = new TemporalKnowledgeGraph(graphFile);
    await graph.init();

    graph.upsertEntity({ id: 'app', name: 'Application', type: 'component', summary: 'Core app' });
    graph.upsertEntity({ id: 'db_v1', name: 'SQLite', type: 'technology', summary: 'Embedded DB' });
    graph.upsertEntity({ id: 'db_v2', name: 'PostgreSQL', type: 'technology', summary: 'Client-server DB' });

    const pastIso = '2025-01-01T00:00:00.000Z';
    const midIso = '2025-06-01T00:00:00.000Z';
    const presentIso = '2026-01-01T00:00:00.000Z';

    // Quan hệ v1: Có hiệu lực từ pastIso tới midIso
    const relV1 = graph.addRelation('app', 'db_v1', 'DEPENDS_ON', { validFrom: pastIso });
    graph.invalidateRelation(relV1.id, 'Migrated to PostgreSQL', midIso);

    // Quan hệ v2: Có hiệu lực từ midIso trở đi
    graph.addRelation('app', 'db_v2', 'DEPENDS_ON', { validFrom: midIso });

    // 1. Snapshot tại thời điểm quá khứ (2025-03-01): Hệ thống dùng SQLite
    const snapshotPast = graph.queryActiveAt('2025-03-01T00:00:00.000Z');
    assert.ok(snapshotPast.relations.some((r) => r.targetEntityId === 'db_v1'));
    assert.equal(snapshotPast.relations.some((r) => r.targetEntityId === 'db_v2'), false);

    // 2. Snapshot tại thời điểm hiện tại (2026-01-01): Hệ thống dùng PostgreSQL
    const snapshotPresent = graph.queryActiveAt(presentIso);
    assert.equal(snapshotPresent.relations.some((r) => r.targetEntityId === 'db_v1'), false);
    assert.ok(snapshotPresent.relations.some((r) => r.targetEntityId === 'db_v2'));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('TemporalKnowledgeGraph - Atomically supersedes decisions and detects conflicts', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tkg-conflict-'));
  const graphFile = path.join(tempDir, 'temporal-graph.json');

  try {
    const graph = new TemporalKnowledgeGraph(graphFile);
    await graph.init();

    // 1. Tạo quyết định cũ
    graph.upsertEntity({
      id: 'decision_test_runner',
      name: 'Test Runner Choice',
      type: 'decision',
      summary: 'Use Jest for unit tests',
    });

    // 2. Thay thế bằng quyết định mới (Supersede)
    const { newEntity, relation } = graph.supersedeDecision(
      'decision_test_runner',
      {
        id: 'decision_test_runner_v2',
        name: 'Test Runner Choice V2',
        type: 'decision',
        summary: 'Migrate to Vitest for ESM speed',
      },
      'ESM support and 10x faster execution',
    );

    assert.equal(newEntity.id, 'decision_test_runner_v2');
    assert.equal(relation.relation, 'REPLACED_BY');
    assert.equal(relation.sourceEntityId, 'decision_test_runner');
    assert.equal(relation.targetEntityId, 'decision_test_runner_v2');

    // 3. Kiểm tra phát hiện xung đột
    graph.upsertEntity({ id: 'module_payment', name: 'Payment Module', type: 'component', summary: 'Stripe' });
    graph.upsertEntity({ id: 'lib_crypto', name: 'Legacy Crypto Lib', type: 'technology', summary: 'MD5 hashing' });

    // Tạo 2 quan hệ đối nghịch nhau: vừa DEPENDS_ON vừa DEPRECATES
    graph.addRelation('module_payment', 'lib_crypto', 'DEPENDS_ON');
    graph.addRelation('module_payment', 'lib_crypto', 'DEPRECATES');

    const conflicts = graph.detectConflicts('module_payment');
    assert.ok(conflicts.length > 0, 'Should detect conflict between DEPENDS_ON and DEPRECATES');
    assert.match(conflicts[0].reason, /simultaneously depends on and deprecates/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('ProjectMemoryManager - Ebbinghaus Memory Decay calculates utility correctly', () => {
  const manager = new ProjectMemoryManager(os.tmpdir());

  const now = Date.now();
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

  // 1. Convention: Half-life 180 ngày -> Sau 30 ngày vẫn giữ utility cao (>0.6)
  const conventionItem = {
    key: 'conv_1',
    insight: 'Use TypeScript strict mode',
    category: 'convention' as const,
    createdAt: thirtyDaysAgo,
    updatedAt: thirtyDaysAgo,
    confidence: 0.9,
    accessCount: 5,
  };
  const conventionUtility = manager.calculateUtility(conventionItem);
  assert.ok(conventionUtility > 0.6, `Convention utility (${conventionUtility}) should remain high after 30 days`);

  // 2. Episodic memory: Half-life 7 ngày -> Sau 30 ngày utility giảm mạnh
  const episodicItem = {
    key: 'session_old',
    insight: 'Fixed small typo in readme',
    category: 'episodic' as const,
    createdAt: thirtyDaysAgo,
    updatedAt: thirtyDaysAgo,
    confidence: 0.8,
    accessCount: 1,
  };
  const episodicUtility = manager.calculateUtility(episodicItem);
  assert.ok(
    episodicUtility < conventionUtility,
    `Episodic utility (${episodicUtility}) should be significantly lower than convention (${conventionUtility})`,
  );

  // 3. Spaced Repetition Effect: Cùng 30 ngày nhưng accessCount cao (12 lần) -> Utility cao hơn hẳn
  const frequentlyUsedEpisodic = {
    ...episodicItem,
    accessCount: 12,
  };
  const boostedUtility = manager.calculateUtility(frequentlyUsedEpisodic);
  assert.ok(
    boostedUtility > episodicUtility,
    `Frequently accessed memory (${boostedUtility}) should decay much slower than rarely accessed memory (${episodicUtility})`,
  );
});

test('ProjectMemoryManager - Syncs architecture and rule insights to TemporalKnowledgeGraph', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-tkg-sync-'));
  try {
    const manager = new ProjectMemoryManager(tempDir);
    await manager.init();

    // 1. Lưu insight kiến trúc
    await manager.saveInsight(
      'arch_database',
      'Use PostgreSQL with connection pooling via PgBouncer',
      'architecture',
      { confidence: 0.95, tags: ['db', 'postgres'] },
    );

    // 2. Kiểm tra entity trong TemporalKnowledgeGraph
    const tkg = manager.getKnowledgeGraph();
    const entity = tkg.getEntity('arch_database');
    assert.ok(entity, 'arch_database entity should be synced to TemporalKnowledgeGraph');
    assert.equal(entity.type, 'decision');
    assert.match(entity.summary, /PostgreSQL with connection pooling/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
