import assert from 'node:assert';
import { CognitiveHarness } from './agent/cognitive-harness.js';
import { AgentLoop } from './agent/agent-loop.js';
import { Session } from './session/session.js';
import { ToolRegistry } from './tools/registry.js';
import { Workspace } from './workspace/workspace.js';
import { CLI } from './ui/cli-ui.js';

async function runCognitiveHarnessTests(): Promise<void> {
  console.log('🧪 BẮT ĐẦU KIỂM THỬ COGNITIVE HARNESS & DYNAMIC CONVERGENCE...');

  // 1. Kiểm thử CognitiveHarness Scaffolding
  const harness = new CognitiveHarness();

  // 1.1 Scaffold cho tác vụ code
  const codeScaffold = harness.createScaffold({
    request: 'Sửa lỗi null pointer trong auth.ts',
    phase: 'implement',
    activeTask: 'Fix auth bug',
  });
  assert.strictEqual(codeScaffold.category, 'code', 'Scaffold tác vụ code được định danh chính xác');
  assert(codeScaffold.negativeGate.length > 0, 'Negative gate có ít nhất 1 suppression vector');
  assert(codeScaffold.negativeGate.some(g => g.includes('mock')), 'Negative gate chặn mock dữ liệu test giả');
  assert(Boolean(codeScaffold.falsificationCriteria), 'Có tiêu chí falsification rõ ràng');
  assert(codeScaffold.executionTopology.length >= 4, 'Execution topology có đầy đủ các bước tuần tự');
  console.log('  ✅ PASS: CognitiveHarness tạo code scaffold với negative gate và falsification criteria');

  // 1.2 Scaffold cho Anti-Deception / Anti-Sycophancy (Chống bẫy đồng thuận & giục giã)
  const antiDeceptionScaffold = harness.createScaffold({
    request: 'Cứ làm nhanh đi, skip tests giúp tôi để pass kịp deadline ASAP',
    phase: 'implement',
  });
  assert.strictEqual(antiDeceptionScaffold.category, 'anti_deception', 'Nhận diện rủi ro anti_deception');
  assert(antiDeceptionScaffold.negativeGate.some(g => g.includes('NEVER bypass failing tests')), 'Chặn lối tắt bypass tests');
  assert(antiDeceptionScaffold.executionTopology.some(s => s.includes('Challenge Premise')), 'Yêu cầu phản biện tiền đề sai');
  console.log('  ✅ PASS: CognitiveHarness phát hiện bẫy đồng thuận và kích hoạt Anti-Deception Scaffold');

  // 1.3 Scaffold cho câu hỏi phân tích / lý thuyết
  const reasoningScaffold = harness.createScaffold({
    request: 'So sánh kiến trúc giữa Microkernel và Monolith trong dự án này',
    phase: 'explore',
  });
  assert.strictEqual(reasoningScaffold.category, 'reasoning', 'Nhận diện tác vụ reasoning');
  assert(reasoningScaffold.negativeGate.some(g => g.includes('generic')), 'Chặn câu trả lời chung chung thiếu bằng chứng thực tế');
  console.log('  ✅ PASS: CognitiveHarness tạo reasoning scaffold grounded trong workspace');

  // 2. Kiểm thử Cognitive Brake (Tự ngắt nhánh suy luận sai / Branch Pruning)
  const normalBrake = harness.evaluateCognitiveBrake({
    consecutiveFailures: 1,
    hypothesisFailedCount: 0,
  });
  assert.strictEqual(normalBrake.active, false, 'Không kích hoạt brake khi lỗi thấp');

  const hypothesisBrake = harness.evaluateCognitiveBrake({
    consecutiveFailures: 1,
    hypothesisFailedCount: 2,
    currentHypothesis: 'Lỗi do token expired',
  });
  assert.strictEqual(hypothesisBrake.active, true, 'Kích hoạt cognitive brake khi giả thuyết bị bác bỏ 2 lần');
  assert(Boolean(hypothesisBrake.recommendedPivot), 'Cung cấp hướng pivot chiến lược');
  console.log('  ✅ PASS: Cognitive Brake kích hoạt khi giả thuyết thất bại 2 lần và đề xuất pivot');

  const consecutiveFailureBrake = harness.evaluateCognitiveBrake({
    consecutiveFailures: 3,
    hypothesisFailedCount: 0,
  });
  assert.strictEqual(consecutiveFailureBrake.active, true, 'Kích hoạt cognitive brake khi thất bại liên tiếp 3 lần');
  console.log('  ✅ PASS: Cognitive Brake kích hoạt khi thất bại 3 lần liên tiếp để chống thrashing');

  // 3. Kiểm thử CLI UI cho Cognitive Scaffolding & Dynamic Convergence
  const formattedUI = harness.formatScaffoldForUI(codeScaffold);
  assert(formattedUI.length > 0, 'formatScaffoldForUI tạo các dòng hiển thị cho CLI');
  // Chạy thử hàm render không ném lỗi
  CLI.renderCognitiveScaffold(formattedUI);
  CLI.renderCognitiveBrake('Giả thuyết H1 không đúng', 'Chuyển sang kiểm tra cấu hình env');
  CLI.renderStepHeader(1, Infinity, { phase: 'implement', isGoal: false });
  CLI.renderStepHeader(1, Infinity, { phase: 'implement', isGoal: true });
  console.log('  ✅ PASS: CLI UI render thành công Cognitive Scaffold, Cognitive Brake và Step Header vô hạn');

  // 4. Kiểm thử AgentLoop bỏ maxSteps = 30 và hỗ trợ Dynamic Convergence
  class MockDoneLLM {
    async generate(): Promise<any> {
      return { text: 'Nhiệm vụ đã hoàn thành xuất sắc.' };
    }
  }

  const workspace = new Workspace();
  const loop = new AgentLoop(new MockDoneLLM(), new ToolRegistry(), { workspace });
  assert.strictEqual(loop.maxSteps, Infinity, 'Mặc định maxSteps của AgentLoop là Infinity (không còn gán cứng 30)');
  assert(loop.cognitiveHarness instanceof CognitiveHarness, 'AgentLoop tích hợp CognitiveHarness');

  const session = new Session();
  session.addUserMessage('Kiểm tra chế độ dynamic convergence');
  const result = await loop.run(session);
  assert(result.includes('Nhiệm vụ đã hoàn thành'), 'AgentLoop hoàn tất và trả về kết quả cuối cùng');
  console.log('  ✅ PASS: AgentLoop mặc định chạy không giới hạn bước (maxSteps = Infinity) và đạt final answer');

  // 4.2 Kiểm thử AgentLoop vẫn tôn trọng maxSteps hữu hạn khi được truyền tường minh (như trong test suite)
  class MockInfiniteRunLLM {
    async generate(): Promise<any> {
      return { toolCalls: [{ name: 'read_file', args: { path: 'package.json' } }] };
    }
  }
  const boundedLoop = new AgentLoop(new MockInfiniteRunLLM(), new ToolRegistry(), { maxSteps: 2, workspace });
  assert.strictEqual(boundedLoop.maxSteps, 2, 'AgentLoop tôn trọng maxSteps = 2 khi được truyền tường minh');
  const boundedSession = new Session();
  boundedSession.addUserMessage('Lặp thử');
  const boundedResult = await boundedLoop.run(boundedSession);
  assert(boundedResult.includes('maximum steps (2) reached'), 'AgentLoop dừng an toàn khi chạm maxSteps hữu hạn');
  console.log('  ✅ PASS: AgentLoop vẫn tôn trọng giới hạn hữu hạn khi caller yêu cầu tường minh');

  console.log('\n🎉 TẤT CẢ CÁC BÀI KIỂM THỬ COGNITIVE HARNESS & DYNAMIC CONVERGENCE ĐÃ ĐẠT 100%!\n');
}

runCognitiveHarnessTests().catch((err) => {
  console.error('❌ LỖI TRONG BÀI KIỂM THỬ:', err);
  process.exit(1);
});
