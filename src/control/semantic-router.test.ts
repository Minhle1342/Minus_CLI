import assert from 'node:assert/strict';
import test from 'node:test';
import { SemanticRouter } from './semantic-router.js';

test('SemanticRouter - Fast-path resolves explicit commands and flags', () => {
  const router = new SemanticRouter();

  const planDecision = router.fastPath('/plan Add user authentication');
  assert.equal(planDecision?.route, 'planning');
  assert.equal(planDecision?.source, 'fast_path');

  const readOnlyDecision = router.fastPath('Review this function, do not edit code');
  assert.equal(readOnlyDecision?.route, 'read_only');
  assert.equal(readOnlyDecision?.source, 'fast_path');

  const viReadOnly = router.fastPath('Chỉ đọc file cấu hình và giải thích');
  assert.equal(viReadOnly?.route, 'read_only');
  assert.equal(viReadOnly?.source, 'fast_path');

  const regular = router.fastPath('Fix deadlock in worker thread');
  assert.equal(regular, null);
});

test('SemanticRouter - Fallback heuristic routes accurately when embedding is bypassed', () => {
  const router = new SemanticRouter();

  assert.equal(router.fallbackRoute('Kiểm tra để cải tiến Tool guidance').route, 'mutation');
  assert.equal(router.fallbackRoute('Khảo sát nhằm cải tiến hàm này').route, 'mutation');
  assert.equal(router.fallbackRoute('Kiểm tra, cải tiến code').route, 'mutation');
  assert.equal(router.fallbackRoute('Kiểm tra các điểm cần cải tiến').route, 'read_only');
  assert.equal(router.fallbackRoute('Đề xuất các điểm cải tiến').route, 'read_only');
  assert.equal(router.fallbackRoute('Giải thích cách hoạt động của parser').route, 'read_only');
});

test('SemanticRouter - routeAsync with FastEmbed ONNX embedding classifier', async () => {
  const router = new SemanticRouter();
  await router.init();
  assert.ok(router.isReady(), 'SemanticRouter should be initialized with FastEmbed');

  const testCases: Array<{ query: string; expectedRoute: 'read_only' | 'mutation' | 'planning' }> = [
    { query: 'Explain how this component works', expectedRoute: 'read_only' },
    { query: 'Giải thích cách hoạt động của parser', expectedRoute: 'read_only' },
    { query: 'Kiểm tra các điểm cần cải tiến', expectedRoute: 'read_only' },
    { query: 'Đề xuất các điểm cải tiến', expectedRoute: 'read_only' },
    { query: 'Kiểm tra để cải tiến Tool guidance', expectedRoute: 'mutation' },
    { query: 'Khảo sát nhằm cải tiến hàm này', expectedRoute: 'mutation' },
    { query: 'Inspect in order to fix the bug', expectedRoute: 'mutation' },
    { query: 'Sửa lỗi deadlock trong worker', expectedRoute: 'mutation' },
    { query: 'Lập kế hoạch thực hiện tính năng mới', expectedRoute: 'planning' },
  ];

  for (const { query, expectedRoute } of testCases) {
    const result = await router.routeAsync(query);
    assert.equal(
      result.route,
      expectedRoute,
      `Query "${query}" expected ${expectedRoute} but got ${result.route} (sim: ${result.score.toFixed(3)}, source: ${result.source})`
    );
    assert.ok(result.score > 0.6, `Score should be confident (>0.6): ${result.score}`);
  }

  // Verify boolean helpers
  assert.equal(await router.isReadOnly('Giải thích cách hoạt động của parser'), true);
  assert.equal(await router.isReadOnly('Kiểm tra để cải tiến Tool guidance'), false);
});

test('SemanticRouter - Gracefully handles empty, whitespace, and nullish queries', async () => {
  const router = new SemanticRouter();
  assert.equal((await router.routeAsync('')).route, 'read_only');
  assert.equal((await router.routeAsync('   ')).route, 'read_only');
  assert.equal(router.routeSync('').route, 'read_only');
});
