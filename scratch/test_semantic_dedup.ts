import { computeTaskSimilarityDetailed, computeTaskSimilarity, AgentOrchestrator } from '../src/agent/agent-orchestrator.js';
import { AgentRegistry } from '../src/agent/agent-registry.js';
import { isNativeAvailable, getNativeVersion } from '../src/native/index.js';

console.log('=== TEST SUITE: BƯỚC 1 - HYBRID SEMANTIC TASK DEDUPLICATION ===');
console.log('Native Addon Available:', isNativeAvailable());
console.log('Native Addon Version:', getNativeVersion());

// Test 1: Hai task cùng bản chất ngữ nghĩa nhưng khác từ vựng
const task1 = 'Fix JWT auth token timeout expiration bug';
const task2 = 'Resolve authentication bearer token expiry issue';
const res12 = computeTaskSimilarityDetailed(task1, task2);
console.log('\n[Test 1] Đồng nhất ngữ nghĩa khác từ vựng:');
console.log('   Task 1:', task1);
console.log('   Task 2:', task2);
console.log('   Scores:', res12);

if (res12.combinedScore < 0.70 || res12.matchType !== 'semantic') {
  throw new Error(`Test 1 Failed: Expected semantic score >= 0.70, got ${res12.combinedScore}`);
}

// Test 2: Hai task hoàn toàn khác biệt
const task3 = 'Optimize image compression for frontend assets';
const res13 = computeTaskSimilarityDetailed(task1, task3);
console.log('\n[Test 2] Khác biệt ngữ nghĩa hoàn toàn:');
console.log('   Task 1:', task1);
console.log('   Task 3:', task3);
console.log('   Scores:', res13);

if (res13.combinedScore >= 0.40) {
  throw new Error(`Test 2 Failed: Expected score < 0.40 for different tasks, got ${res13.combinedScore}`);
}

// Test 3: Tích hợp với Orchestrator Anti-Duplication
console.log('\n[Test 3] Kiểm tra chặn trùng lặp trong AgentOrchestrator:');
const registry = new AgentRegistry();
registry.register('agent-sec', 'Security Specialist');
registry.update('agent-sec', { capabilities: ['auth', 'security'] });
const orchestrator = new AgentOrchestrator(registry);

// Cấp phát task 1
orchestrator.allocateTask(task1, ['auth'], { checkAntiDuplication: true });
console.log('   Task 1 allocated successfully.');

// Cố gắng cấp phát task 2 (ngữ nghĩa giống task 1)
try {
  orchestrator.allocateTask(task2, ['auth'], { checkAntiDuplication: true });
  throw new Error('Test 3 Failed: Orchestrator should have rejected duplicate semantic task!');
} catch (err: any) {
  if (err.message.includes('DUPLICATE_TASK_DETECTED') && err.message.includes('Semantic Vector SIMD')) {
    console.log('   ✅ Đã chặn thành công với thông điệp:');
    console.log('   ', err.message);
  } else {
    throw err;
  }
}

console.log('\n🎉 TOÀN BỘ KIỂM TRA BƯỚC 1 ĐẠT 100%! BƯỚC 1 HOÀN TẤT XUẤT SẮC!');
