import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRetriever } from '../tools/tool-retriever.js';
import { ToolRegistry } from '../tools/registry.js';

test('ToolRetriever - Adaptive Tool Schema Pruning removes heavy game tools on regular code queries', async () => {
  const registry = new ToolRegistry(undefined, undefined, undefined, { enableGameTools: true });
  await registry.registerGameTools();
  const allTools = registry.getAll();

  // Đảm bảo trong registry có cả tool thông thường và tool game
  assert.ok(allTools.some((t) => t.name.startsWith('game_') || t.name.startsWith('unity_')), 'Registry must contain game tools');

  const retriever = new ToolRetriever({ enabled: true, activationThreshold: 5, topK: 4 });
  retriever.indexTools(allTools);

  // 1. Khi truy vấn code thông thường: KHÔNG được chứa tool game chuyên biệt
  const regularDeclarations = retriever.retrieve('fix authentication bug and inspect src/auth.ts', allTools);
  const regularToolNames = regularDeclarations.map((d) => d.name);

  // Core Anchor Tools phải luôn hiện diện (bảo toàn 100% accuracy)
  assert.ok(regularToolNames.includes('read_file'), 'Must include read_file');
  assert.ok(regularToolNames.includes('search_text'), 'Must include search_text');
  assert.ok(regularToolNames.includes('replace_text'), 'Must include replace_text');
  assert.ok(regularToolNames.includes('run_command'), 'Must include run_command');

  // Tool game nặng KHÔNG được xuất hiện
  const hasGameToolInRegular = regularToolNames.some((name) => name.startsWith('game_') || name.startsWith('unity_'));
  assert.equal(hasGameToolInRegular, false, 'Heavy game tools must be pruned from regular coding queries');

  // 2. Khi truy vấn thực sự liên quan tới Game / Unity: Tự động bung tool Game
  const gameDeclarations = retriever.retrieve('create 2d pixel character sprite for unity game', allTools);
  const gameToolNames = gameDeclarations.map((d) => d.name);

  const hasGameToolInGameQuery = gameToolNames.some((name) => name.startsWith('game_') || name.startsWith('unity_'));
  assert.equal(hasGameToolInGameQuery, true, 'Game tools must be dynamically included when query explicitly asks for game/unity');
});

test('ToolRetriever - Schema token reduction preserves anchor tools and stays within budget', async () => {
  const registry = new ToolRegistry(undefined, undefined, undefined, { enableGameTools: true });
  await registry.registerGameTools();
  const allTools = registry.getAll();
  const retriever = new ToolRetriever({ enabled: true, activationThreshold: 5, topK: 3 });
  retriever.indexTools(allTools);

  const prunedDeclarations = retriever.retrieve('run unit tests and check git status', allTools);
  
  // Tổng số tools sau khi prune phải nhỏ hơn đáng kể so với toàn bộ registry
  assert.ok(
    prunedDeclarations.length < allTools.length,
    `Pruned declarations (${prunedDeclarations.length}) should be less than all tools (${allTools.length})`
  );

  // Kiểm tra Core anchors không bị mất
  const names = new Set(prunedDeclarations.map((d) => d.name));
  assert.ok(names.has('run_command'), 'Must retain run_command');
  assert.ok(names.has('read_file'), 'Must retain read_file');
  assert.ok(names.has('search_text'), 'Must retain search_text');
});
