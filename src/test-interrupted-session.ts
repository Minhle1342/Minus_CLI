import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from './workspace/workspace.js';
import { Session } from './session/session.js';
import { SessionPersistence } from './session/session-persistence.js';
import { loadSession, saveSession, clearSession } from './session/persistent-session.js';
import { PlanManager } from './agent/plan-manager.js';
import { GoalManager } from './agent/goal-manager.js';
import { ToolRegistry } from './tools/registry.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ PASS: ${message}`);
  } else {
    failed++;
    console.error(`  ❌ FAIL: ${message}`);
  }
}

async function runRecoveryTests() {
  console.log('\n========================================');
  console.log('🧪 TEST SUITE: RESILIENT INTERRUPTED SESSION RECOVERY & PERSISTENCE');
  console.log('========================================\n');

  // 1. Kiểm tra PlanManager bảo toàn incomplete plan khi chuyển turn có cờ preserveIncompletePlan
  console.log('1. Kiểm thử PlanManager bảo toàn kế hoạch khi Resume/Tiếp tục');
  const resilientSession = new Session('resilient-plan-preservation-test');
  const resilientPlanMgr = new PlanManager();
  resilientPlanMgr.bindSession(resilientSession);
  resilientPlanMgr.beginTurn(1, 'Refactor Authentication & Session Tokens');
  resilientPlanMgr.createPlan([
    { id: 1, title: 'Inspect Auth Module', acceptanceCriteria: 'Tokens inspected' },
    { id: 2, title: 'Refactor Token Storage', acceptanceCriteria: 'Storage updated' },
    { id: 3, title: 'Verify Tests', acceptanceCriteria: 'All unit tests pass' },
  ]);
  resilientPlanMgr.recordToolEvidence('read_file', { path: 'auth.ts' }, { content: 'token logic' });
  resilientPlanMgr.updateTask(1, 'COMPLETED', 'Inspected auth logic');

  // Lượt 2 bắt đầu với preserveIncompletePlan = true (mô phỏng resume prompt hoặc goal continuation)
  resilientPlanMgr.beginTurn(2, '[RESUME INCOMPLETE PLAN] Next Target Task #2', { preserveIncompletePlan: true });
  assert(resilientPlanMgr.getTasks().length === 3, 'PlanManager bảo toàn trọn vẹn 3 task khi turn mới tiếp tục kế hoạch dang dở');
  assert(resilientPlanMgr.getTasks()[0].status === 'COMPLETED', 'Task 1 vẫn COMPLETED sau khi chuyển turn tiếp tục');
  assert(resilientPlanMgr.getNextIncompleteTask()?.id === 2, 'getNextIncompleteTask trỏ chính xác vào Task #2 dở dang');
  assert(resilientPlanMgr.renderExecutionContext().includes('Task #2') || resilientPlanMgr.renderExecutionContext().includes('Refactor Token Storage'), 'renderExecutionContext hiển thị đầy đủ ngữ cảnh task dở dang cho LLM');

  // 2. Kiểm tra phân lập file cấu hình session.json theo từng Workspace riêng biệt
  console.log('\n2. Kiểm thử phân lập Workspace Session Configuration');
  const wsDirA = path.join(process.cwd(), 'temp', 'test-ws-a');
  const wsDirB = path.join(process.cwd(), 'temp', 'test-ws-b');
  await fs.mkdir(wsDirA, { recursive: true });
  await fs.mkdir(wsDirB, { recursive: true });

  saveSession({ modelName: 'gemini-2.5-flash', activeSessionId: 'sess-aaa-111' }, wsDirA);
  saveSession({ modelName: 'groq/llama-3.3-70b', activeSessionId: 'sess-bbb-222' }, wsDirB);

  const loadedA = loadSession(wsDirA);
  const loadedB = loadSession(wsDirB);
  assert(loadedA.activeSessionId === 'sess-aaa-111' && loadedA.modelName === 'gemini-2.5-flash', 'Workspace A lưu và nạp đúng session riêng của mình');
  assert(loadedB.activeSessionId === 'sess-bbb-222' && loadedB.modelName === 'groq/llama-3.3-70b', 'Workspace B lưu và nạp đúng session riêng của mình');
  assert(loadedA.activeSessionId !== loadedB.activeSessionId, 'Cấu hình session của hai workspace không bị ghi đè lẫn nhau');

  // 3. Kiểm tra SessionPersistence.findLatestInterruptedSession()
  console.log('\n3. Kiểm thử Tự động Quét & Phát hiện Phiên Dở dang (findLatestInterruptedSession)');
  const testPersistenceWs = path.join(process.cwd(), 'temp', 'test-persistence-discovery');
  const testPersistence = new SessionPersistence(testPersistenceWs);
  const interruptedSession = new Session('session-interrupted-goal-1');
  const goalMgrTest = new GoalManager();
  goalMgrTest.bindSession(interruptedSession);
  goalMgrTest.create('Migrate Database Schemas and Seed Data');
  goalMgrTest.pause('LLM Quota Limit Exceeded');
  interruptedSession.append('goal/change', { reason: 'paused', goal: goalMgrTest.getState() });
  await testPersistence.save(interruptedSession);

  const discovered = await testPersistence.findLatestInterruptedSession();
  assert(discovered !== undefined, 'findLatestInterruptedSession tìm thấy phiên gián đoạn');
  assert(discovered?.sessionId === 'session-interrupted-goal-1', 'Đúng ID phiên gián đoạn');
  assert(discovered?.goal === 'Migrate Database Schemas and Seed Data', 'Trích xuất đúng mục tiêu của phiên dở dang');
  assert(discovered?.phase === 'paused', 'Nhận diện đúng phase paused');

  // 4. Kiểm tra cờ wasInterruptedAndRecovered khi load session bị crash
  console.log('\n4. Kiểm thử Crash Recovery & Đánh dấu Khôi phục');
  const crashedSession = new Session('session-crashed-test');
  crashedSession.append('turn/start', { turn: 1 });
  crashedSession.append('tool/call', { toolName: 'read_file', toolCallId: 'call-1', args: { path: 'a.txt' } });
  // Chưa có tool/result và turn/end -> mô phỏng crash giữa chừng
  await testPersistence.save(crashedSession);

  const recoveredSession = await testPersistence.load('session-crashed-test');
  assert(recoveredSession !== undefined, 'Load session thành công');
  assert((recoveredSession as any).wasInterruptedAndRecovered === true, 'Đánh dấu wasInterruptedAndRecovered khi session được tự động vá sau crash');

  // 5. Kiểm thử phiên ĐÃ HOÀN THÀNH (Plan completed & Goal completed) -> KHÔNG bị nhận nhầm là gián đoạn
  console.log('\n5. Kiểm thử phiên ĐÃ HOÀN THÀNH (Không báo False Positive)');
  const testCompletedWs = path.join(process.cwd(), 'temp', 'test-completed-session');
  const testCompletedPersistence = new SessionPersistence(testCompletedWs);
  const completedSession = new Session('session-completed-1');
  const goalMgrCompleted = new GoalManager();
  const planMgrCompleted = new PlanManager();
  goalMgrCompleted.bindSession(completedSession);
  planMgrCompleted.bindSession(completedSession);

  completedSession.append('turn/start', { turn: 1 });
  goalMgrCompleted.create('Deploy Production Release');
  planMgrCompleted.createPlan([
    { id: 1, title: 'Build Project', acceptanceCriteria: 'Build succeeds' },
    { id: 2, title: 'Run Tests', acceptanceCriteria: 'Tests pass' },
  ]);
  planMgrCompleted.recordToolEvidence('run_command', { command: 'npm run build' }, { success: true });
  planMgrCompleted.updateTask(1, 'COMPLETED', 'Build succeeded');
  planMgrCompleted.recordToolEvidence('run_command', { command: 'npm test' }, { success: true });
  planMgrCompleted.updateTask(2, 'COMPLETED', 'All tests passed');
  goalMgrCompleted.complete(planMgrCompleted);
  completedSession.append('turn/end', { turn: 1, reason: 'completed' });
  await testCompletedPersistence.save(completedSession);

  const shouldBeNone = await testCompletedPersistence.findLatestInterruptedSession();
  assert(shouldBeNone === undefined, 'findLatestInterruptedSession KHÔNG phát hiện phiên đã hoàn thành 100%');
  assert(planMgrCompleted.isAllTasksCompleted() === true, 'isAllTasksCompleted xác nhận đúng toàn bộ task đã COMPLETED');
  assert(planMgrCompleted.getNextIncompleteTask() === undefined, 'getNextIncompleteTask trả về undefined khi không còn task dở dang');
  assert(goalMgrCompleted.getState()?.phase === 'complete', 'Goal state có phase là complete');

  // 6. Kiểm thử phiên bị gián đoạn ở Turn 1 nhưng được LLM hoàn thành task cuối ở Turn 2
  console.log('\n6. Kiểm thử phiên được tiếp tục và hoàn thành task cuối ở lượt sau');
  const multiTurnSession = new Session('session-resumed-and-finished-1');
  const goalMgrMulti = new GoalManager();
  const planMgrMulti = new PlanManager();
  goalMgrMulti.bindSession(multiTurnSession);
  planMgrMulti.bindSession(multiTurnSession);

  // Turn 1: Bị gián đoạn sau Task 1
  multiTurnSession.append('turn/start', { turn: 1 });
  goalMgrMulti.create('Full System Audit');
  planMgrMulti.createPlan([
    { id: 1, title: 'Security Audit', acceptanceCriteria: 'No vuln' },
    { id: 2, title: 'Performance Audit', acceptanceCriteria: 'Fast response' },
  ]);
  planMgrMulti.updateTask(1, 'COMPLETED', 'Security audit passed');
  goalMgrMulti.pause('SIGINT received');
  multiTurnSession.append('turn/end', { turn: 1, reason: 'interrupted' });
  await testCompletedPersistence.save(multiTurnSession);

  // Lúc này scanner phải phát hiện dở dang Task #2
  const detectedAtTurn1 = await testCompletedPersistence.findLatestInterruptedSession();
  assert(detectedAtTurn1 !== undefined && detectedAtTurn1.sessionId === 'session-resumed-and-finished-1', 'Phát hiện chính xác phiên dở dang tại Turn 1');
  assert(Boolean(detectedAtTurn1?.incompleteTask?.includes('Task #2')), 'Chỉ đúng Task #2 còn thiếu');

  // Turn 2: LLM tiếp tục và hoàn thành nốt Task 2
  multiTurnSession.append('turn/start', { turn: 2 });
  goalMgrMulti.resume();
  planMgrMulti.beginTurn(2, '[RESUME INCOMPLETE PLAN] Next Target Task #2', { preserveIncompletePlan: true });
  planMgrMulti.recordToolEvidence('run_command', { command: 'audit-perf' }, { success: true });
  planMgrMulti.updateTask(2, 'COMPLETED', 'Performance latency < 50ms');
  goalMgrMulti.complete(planMgrMulti);
  multiTurnSession.append('turn/end', { turn: 2, reason: 'completed' });
  await testCompletedPersistence.save(multiTurnSession);

  // Lúc này scanner KHÔNG còn phát hiện phiên này là dở dang nữa
  const detectedAtTurn2 = await testCompletedPersistence.findLatestInterruptedSession();
  assert(detectedAtTurn2 === undefined, 'Sau khi hoàn thành task cuối ở Turn 2, scanner không còn coi phiên này là gián đoạn');

  // 8. Kiểm thử Auto-Reconciliation cho Durable Goal Mode đã hoàn thành
  console.log('\n8. Kiểm thử Goal Auto-Reconciliation khi turn đã hoàn thành');
  const wsGoalReconcile = path.join(os.tmpdir(), `test-goal-reconcile-${Date.now()}`);
  const goalPersist = new SessionPersistence(wsGoalReconcile);
  const goalReconcileSession = new Session();
  goalReconcileSession.append('goal/change', {
    reason: 'created',
    goal: {
      id: 'goal-admin-ui',
      revision: 1,
      objective: 'tạo full trang quản lý ở dạng tĩnh của admin',
      phase: 'active',
      roundsStarted: 1,
      maxRounds: 32,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  goalReconcileSession.append('plan/change', {
    reason: 'completed',
    plan: [
      { id: 1, title: 'Tạo UI tĩnh', status: 'COMPLETED', writeSet: ['admin.html'] },
      { id: 2, title: 'Kiểm thử UI', status: 'COMPLETED', writeSet: [] },
    ],
  });
  goalReconcileSession.append('turn/end', { turn: 1, reason: 'completed' });
  await goalPersist.save(goalReconcileSession);

  // Scanner không được coi phiên này là gián đoạn
  const scanReconciled = await goalPersist.findLatestInterruptedSession();
  assert(scanReconciled === undefined, 'findLatestInterruptedSession tự động reconcile Goal completed và không trả về candidate');

  // GoalManager khi nạp session này cũng tự động reconcile sang 'complete'
  const goalMgrReconciled = new GoalManager();
  goalMgrReconciled.bindSession(goalReconcileSession);
  const reconciledState = goalMgrReconciled.getState();
  assert(reconciledState?.phase === 'complete', 'GoalManager tự động chuyển phase sang "complete" khi plan đã hoàn tất 100%');

  // Dọn dẹp temp
  await fs.rm(wsGoalReconcile, { recursive: true, force: true }).catch(() => {});
  await fs.rm(wsDirA, { recursive: true, force: true }).catch(() => {});
  await fs.rm(wsDirB, { recursive: true, force: true }).catch(() => {});
  await fs.rm(testPersistenceWs, { recursive: true, force: true }).catch(() => {});
  await fs.rm(testCompletedWs, { recursive: true, force: true }).catch(() => {});

  console.log(`\n========================================`);
  console.log(`KẾT QUẢ RECOVERY TESTS: ${passed} Passed, ${failed} Failed`);
  console.log('========================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runRecoveryTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
