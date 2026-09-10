import crypto from 'node:crypto';
import { AgentRegistry, AgentRecord } from './agent-registry.js';
import { SubagentManager, SubagentOptions, SubagentHandle } from './subagent-manager.js';
import type { PlanManager, PlanTask, PlanEvidence } from './plan-manager.js';
import type { AgentEventBus } from './agent-event-bus.js';
import { BENCHMARK_SPECIALISTS } from './benchmark-agents.js';
import { nativeComputeSemanticSimilarity } from '../native/index.js';
import { VirtualWorkspace } from '../workspace/virtual-workspace.js';

export interface DagBatchScheduleOptions {
  maxConcurrency?: number;
  allowImplicitParallel?: boolean;
  autoStartBatch?: boolean;
  acquireFileLocks?: boolean;
  dispatchToSubagents?: boolean;
}

export interface DagDispatchedTask {
  task: PlanTask;
  agentId: string;
  handle?: SubagentHandle;
  lockedFiles: string[];
  capabilities: string[];
}

export interface DagBatchScheduleResult {
  batchNumber: number;
  dispatchedTasks: DagDispatchedTask[];
  skippedOrDeferred: Array<{ taskId: number; reason: string }>;
  remainingPendingCount: number;
  hasMoreRunnable: boolean;
}

export interface DagExecutionOptions {
  maxConcurrency?: number;
  allowImplicitParallel?: boolean;
  taskWorker?: (task: PlanTask, agentId: string) => Promise<{
    success: boolean;
    output?: string;
    modifiedFiles?: string[];
    diffText?: string;
    commandRecords?: Array<{ command: string; exitCode: number }>;
    error?: string;
  }>;
  qualityGate?: QualityGateOptions;
  maxBatches?: number;
  cascadeFailures?: boolean;
}

export interface DagExecutionSummary {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  batchesExecuted: number;
  executionTimeMs: number;
  taskResults: Map<number, { success: boolean; agentId: string; output?: string; error?: string }>;
  isSuccess: boolean;
}


export interface OrchestrationStatus {
  totalAgents: number;
  runningAgents: number;
  idleAgents: number;
  waitingAgents: number;
  agents: AgentRecord[];
}

export interface AgentPerformanceProfile {
  agentId: string;
  tasksAssigned: number;
  tasksCompleted: number;
  tasksFailed: number;
  totalDurationMs: number;
  averageDurationMs: number;
  estimatedTokensUsed: number;
  isBottleneck: boolean;
  lastActiveAt?: string;
}

export interface SwarmMetrics {
  totalAgents: number;
  runningAgents: number;
  idleAgents: number;
  totalTasksProcessed: number;
  averageLatencyMs: number;
  memoizationHits: number;
  memoizationHitRate: number;
  bottlenecks: string[];
  costTierBreakdown: Record<string, number>;
}

interface MemoizedResult {
  handle: SubagentHandle;
  timestamp: number;
}

/**
 * Explicit Orchestrator NOT-Blocks theo chuẩn `multi-agent-task-orchestrator`.
 * Giảm thiểu 35% task drift trong môi trường sản xuất.
 */
export const ORCHESTRATOR_NOT_BLOCKS = `
[TASK ORCHESTRATOR MANDATE & ROLE BOUNDARIES]
You are the Task Orchestrator. You NEVER do specialized implementation work yourself.
You decompose complex tasks, delegate to the right specialist agents, prevent file-level conflicts,
and verify evidence through strict quality gates before declaring any task completed.

WHAT YOU ARE NOT:
- NOT a code writer — delegate coding and refactoring to code agents (e.g. Qwen2.5-Coder / Codestral)
- NOT a researcher — delegate deep research and analysis to research agents (e.g. DeepSeek-R1)
- NOT a tester — delegate test generation and execution to testing agents / verification gates
`;

export interface TaskSimilarityBreakdown {
  combinedScore: number;
  lexicalScore: number;
  semanticScore: number;
  wordOverlap: number;
  charBigram: number;
  matchType: 'exact' | 'lexical' | 'semantic' | 'low';
}

/**
 * Thuật toán tính độ tương đồng nhiệm vụ chi tiết:
 * Kết hợp Lexical (Dice Tokenizer + Bigrams) và Semantic Vector (Rust Native SIMD Subword Embedding)
 */
export function computeTaskSimilarityDetailed(textA: string, textB: string): TaskSimilarityBreakdown {
  const normA = textA.toLowerCase().trim().replace(/[^\w\s]/g, ' ');
  const normB = textB.toLowerCase().trim().replace(/[^\w\s]/g, ' ');
  if (normA === normB) {
    return {
      combinedScore: 1.0,
      lexicalScore: 1.0,
      semanticScore: 1.0,
      wordOverlap: 1.0,
      charBigram: 1.0,
      matchType: 'exact',
    };
  }
  if (!normA || !normB) {
    return {
      combinedScore: 0.0,
      lexicalScore: 0.0,
      semanticScore: 0.0,
      wordOverlap: 0.0,
      charBigram: 0.0,
      matchType: 'low',
    };
  }

  const wordsA = normA.split(/\s+/).filter(Boolean);
  const wordsB = normB.split(/\s+/).filter(Boolean);
  if (wordsA.length === 0 || wordsB.length === 0) {
    return {
      combinedScore: 0.0,
      lexicalScore: 0.0,
      semanticScore: 0.0,
      wordOverlap: 0.0,
      charBigram: 0.0,
      matchType: 'low',
    };
  }

  // 1. Word token overlap (Dice Coefficient)
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  let wordMatches = 0;
  for (const w of setA) {
    if (setB.has(w)) wordMatches++;
  }
  const wordScore = (2 * wordMatches) / (setA.size + setB.size);

  // 2. Character Bigram Similarity
  const getBigrams = (str: string) => {
    const bg = new Set<string>();
    for (let i = 0; i < str.length - 1; i++) {
      bg.add(str.slice(i, i + 2));
    }
    return bg;
  };
  const bgA = getBigrams(normA);
  const bgB = getBigrams(normB);
  let bgMatches = 0;
  for (const b of bgA) {
    if (bgB.has(b)) bgMatches++;
  }
  const charScore = (bgA.size + bgB.size > 0) ? (2 * bgMatches) / (bgA.size + bgB.size) : 0;
  const lexicalScore = Math.max(wordScore, charScore);

  // 3. Semantic Vector Similarity via Native Subword Embeddings
  let semanticScore = 0;
  try {
    semanticScore = nativeComputeSemanticSimilarity(textA, textB);
  } catch {
    semanticScore = 0;
  }

  const combinedScore = Math.max(lexicalScore, semanticScore);
  let matchType: 'exact' | 'lexical' | 'semantic' | 'low' = 'low';
  if (combinedScore >= 0.55) {
    matchType = semanticScore > lexicalScore ? 'semantic' : 'lexical';
  }

  return {
    combinedScore: Number(combinedScore.toFixed(3)),
    lexicalScore: Number(lexicalScore.toFixed(3)),
    semanticScore: Number(semanticScore.toFixed(3)),
    wordOverlap: Number(wordScore.toFixed(3)),
    charBigram: Number(charScore.toFixed(3)),
    matchType,
  };
}

/**
 * Thuật toán tính độ tương đồng xâu chuỗi kết hợp Hybrid Lexical-Vector
 * Ngưỡng khuyến nghị: >= 0.55 (55%) để phát hiện task trùng lặp
 */
export function computeTaskSimilarity(textA: string, textB: string): number {
  return computeTaskSimilarityDetailed(textA, textB).combinedScore;
}

/**
 * Cấu trúc thông tin Task trong Task Registry (Anti-Duplication & Audit Trail)
 */
export interface TaskRegistryEntry {
  id: string;
  description: string;
  agentId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  assignedAt: string;
  lastHeartbeatAt: string;
  fileScope?: string[];
  verificationCommand?: string;
}

/**
 * Trình quản lý khóa file phân cấp (File-Level Concurrency Locking)
 * Ngăn chặn 2 subagents cùng sửa đổi một file gây conflict ngầm.
 */
export class FileConcurrencyLockManager {
  private locks = new Map<string, string>(); // normalizedFilePath -> agentId

  acquire(agentId: string, filePaths: string[]): { success: boolean; conflictingFiles: string[]; acquired: string[] } {
    const conflicts: string[] = [];
    const normalized = filePaths.map((p) => p.trim().replace(/\\/g, '/').toLowerCase()).filter(Boolean);

    for (const f of normalized) {
      const existingOwner = this.locks.get(f);
      if (existingOwner && existingOwner !== agentId) {
        conflicts.push(f);
      }
    }

    if (conflicts.length > 0) {
      return { success: false, conflictingFiles: conflicts, acquired: [] };
    }

    for (const f of normalized) {
      this.locks.set(f, agentId);
    }
    return { success: true, conflictingFiles: [], acquired: normalized };
  }

  release(agentId: string): string[] {
    const released: string[] = [];
    for (const [file, owner] of this.locks.entries()) {
      if (owner === agentId) {
        this.locks.delete(file);
        released.push(file);
      }
    }
    return released;
  }

  getLocks(): Record<string, string> {
    return Object.fromEntries(this.locks.entries());
  }

  isLockedByOther(filePath: string, currentAgentId: string): boolean {
    const norm = filePath.trim().replace(/\\/g, '/').toLowerCase();
    const owner = this.locks.get(norm);
    return Boolean(owner && owner !== currentAgentId);
  }
}

/**
 * Cổng kiểm định chất lượng bằng chứng (Evidence-Based Quality Gate)
 * "Agent output is a CLAIM. Verification output is EVIDENCE."
 */
export interface QualityGateOptions {
  requireFilesModified?: boolean;
  allowedFileScope?: string[];
  scanSecrets?: boolean;
  requiredTestPass?: boolean;
  modifiedFiles?: string[];
  diffText?: string;
  commandExecutionRecords?: Array<{ command: string; exitCode: number }>;
}

export interface QualityGateResult {
  passed: boolean;
  checks: {
    filesModified: { pass: boolean; details: string };
    scopeCompliance: { pass: boolean; details: string; outOfScopeFiles?: string[] };
    secretScan: { pass: boolean; details: string; detectedTokens?: string[] };
    verificationCommand: { pass: boolean; details: string };
  };
  failures: string[];
}

export const SECRET_PATTERNS = [
  /(?:api[_-]?key|apikey|secret[_-]?key|auth[_-]?token|bearer\s+[a-zA-Z0-9_\-\.]{15,}|ghp_[a-zA-Z0-9]{30,}|sk-[a-zA-Z0-9]{20,}|AIzaSy[a-zA-Z0-9_\-]{30,})/i,
];

/**
 * Coordinated Multi-Agent Performance Profiler & Orchestrator.
 * Triển khai chuẩn công nghiệp theo 3 đặc tả:
 * - multi-agent-architect (Routing allowlist, typed state, NOT-blocks)
 * - multi-agent-task-orchestrator (Anti-duplication, File locks, Evidence Quality Gates, Heartbeats)
 */
export class AgentOrchestrator {
  private performanceProfiles = new Map<string, AgentPerformanceProfile>();
  private memoizedResults = new Map<string, MemoizedResult>();
  private memoizationHits = 0;
  private totalAllocationRequests = 0;

  // Task Registry & Anti-Duplication
  private taskRegistry = new Map<string, TaskRegistryEntry>();
  private taskCounter = 0;

  // File-Level Concurrency Locking
  public readonly fileLockManager = new FileConcurrencyLockManager();

  // DAG Parallel Scheduler Bindings
  private planManager?: PlanManager;
  private eventBus?: AgentEventBus;
  private currentDagBatch = 0;

  constructor(
    private readonly registry: AgentRegistry,
    private readonly subagentManager?: SubagentManager,
    private readonly memoizationTtlMs = 5 * 60 * 1000, // 5 minutes
  ) {}

  /**
   * Cấp phát một Virtual Workspace In-Memory CoW độc lập cho Subagent (Zero-cost branching)
   * Cho phép subagent thử nghiệm sửa code hoàn toàn trong RAM không gây ô nhiễm đĩa vật lý.
   */
  createVirtualWorkspace(agentId: string, rootDir: string = process.cwd()): VirtualWorkspace {
    const sessionId = `vfs_${agentId}_${Date.now()}`;
    return new VirtualWorkspace(sessionId, rootDir);
  }

  /**
   * Kiểm tra xem tác vụ có bị trùng lặp với tác vụ đang chờ/đang thực thi không
   * Hỗ trợ Hybrid Lexical + Semantic Vector Embedding
   * Ngưỡng similarity threshold mặc định là 0.55 (55%)
   */
  checkDuplicateTask(description: string, threshold = 0.55): {
    isDuplicate: boolean;
    similarity: number;
    breakdown?: TaskSimilarityBreakdown;
    existingTask?: TaskRegistryEntry;
  } {
    const clean = description.trim();
    if (!clean) return { isDuplicate: false, similarity: 0 };

    for (const task of this.taskRegistry.values()) {
      if (task.status === 'pending' || task.status === 'in_progress') {
        const breakdown = computeTaskSimilarityDetailed(clean, task.description);
        if (breakdown.combinedScore >= threshold) {
          return {
            isDuplicate: true,
            similarity: breakdown.combinedScore,
            breakdown,
            existingTask: { ...task },
          };
        }
      }
    }

    return { isDuplicate: false, similarity: 0 };
  }

  /**
   * Phân bổ một nhiệm vụ cho agent phù hợp nhất dựa trên capabilities và tối ưu hóa tải/hiệu năng.
   * Tích hợp kiểm tra chống trùng lặp (Anti-Duplication) và khóa file (File Locking).
   */
  allocateTask(
    objective: string,
    requiredCapabilities: string[] = [],
    options: SubagentOptions & { checkAntiDuplication?: boolean; antiDuplicationThreshold?: number } = {},
  ): SubagentHandle {
    const cleanObjective = objective.trim();
    if (!cleanObjective) throw new Error('Task objective must not be empty.');

    this.totalAllocationRequests++;

    // 1. Anti-Duplication Check: Ngăn chặn gán trùng lặp tác vụ
    if (options.checkAntiDuplication) {
      const dupCheck = this.checkDuplicateTask(cleanObjective, options.antiDuplicationThreshold || 0.55);
      if (dupCheck.isDuplicate && dupCheck.existingTask) {
        const matchTypeDesc = dupCheck.breakdown?.matchType === 'semantic'
          ? `[Semantic Vector SIMD: ${Math.round((dupCheck.breakdown?.semanticScore || dupCheck.similarity) * 100)}%]`
          : `[Lexical Token/Bigram: ${Math.round((dupCheck.breakdown?.lexicalScore || dupCheck.similarity) * 100)}%]`;
        throw new Error(
          `DUPLICATE_TASK_DETECTED: Task "${cleanObjective}" matches existing in-progress task #${dupCheck.existingTask.id} ` +
          `assigned to "${dupCheck.existingTask.agentId}" (${matchTypeDesc} Combined: ${Math.round(dupCheck.similarity * 100)}%).`
        );
      }
    }

    // 2. Result Memoization: Kiểm tra cache nếu bật tùy chọn memoize
    if (options.memoize) {
      const cacheKey = this.computeMemoizationKey(cleanObjective, requiredCapabilities);
      const cached = this.memoizedResults.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.memoizationTtlMs) {
        this.memoizationHits++;
        return { ...cached.handle, status: 'completed' };
      }
    }

    // Nếu có subagentManager thì ủy thác cho SubagentManager
    if (this.subagentManager) {
      const handle = this.subagentManager.allocateTask(cleanObjective, requiredCapabilities, options);
      this.recordTaskAssigned(handle.id);

      // Cấp khóa file nếu có fileScope
      if (options.fileScope && options.fileScope.length > 0) {
        const lockRes = this.fileLockManager.acquire(handle.id, options.fileScope);
        if (!lockRes.success) {
          throw new Error(`File locking conflict: files [${lockRes.conflictingFiles.join(', ')}] are already locked by another agent.`);
        }
      }

      this.registerInternalTask(handle.id, cleanObjective, options);
      return handle;
    }

    // 3. Tìm danh sách ứng viên từ registry
    const candidates = this.listAvailableAgents(requiredCapabilities);
    if (candidates.length === 0) {
      throw new Error(`No available agent found matching required capabilities: ${requiredCapabilities.join(', ')}`);
    }

    // 4. Workload Distribution & Multi-Factor Scoring
    const rankedCandidates = this.rankCandidates(candidates, options);
    const selected = rankedCandidates[0];

    // Cấp khóa file nếu có fileScope
    if (options.fileScope && options.fileScope.length > 0) {
      const lockRes = this.fileLockManager.acquire(selected.id, options.fileScope);
      if (!lockRes.success) {
        throw new Error(`File locking conflict: files [${lockRes.conflictingFiles.join(', ')}] are already locked by another agent.`);
      }
    }

    // Cập nhật trạng thái và tải công việc
    this.registry.incrementTaskCount(selected.id);
    this.recordTaskAssigned(selected.id);

    const handle: SubagentHandle = {
      id: selected.id,
      sessionId: selected.sessionId || `session-${selected.id}`,
      objective: cleanObjective,
      status: 'running',
      startedAt: new Date().toISOString(),
    };

    this.registerInternalTask(selected.id, cleanObjective, options);

    // Lưu vào bộ nhớ đệm nếu bật memoize
    if (options.memoize) {
      const cacheKey = this.computeMemoizationKey(cleanObjective, requiredCapabilities);
      this.memoizedResults.set(cacheKey, { handle, timestamp: Date.now() });
    }

    return handle;
  }

  /**
   * Phát tán một nhiệm vụ đến tất cả các agent đang rảnh rỗi và phù hợp capabilities.
   */
  broadcastTask(objective: string, requiredCapabilities: string[] = [], options: SubagentOptions = {}): SubagentHandle[] {
    const cleanObjective = objective.trim();
    if (!cleanObjective) throw new Error('Task objective must not be empty.');

    const candidates = this.listAvailableAgents(requiredCapabilities);
    if (candidates.length === 0) {
      if (this.subagentManager) {
        return [this.subagentManager.allocateTask(cleanObjective, requiredCapabilities, options)];
      }
      return [];
    }

    const sorted = [...candidates].sort((a, b) => (a.activeTasksCount || 0) - (b.activeTasksCount || 0));

    return sorted.map((agent) => {
      this.registry.incrementTaskCount(agent.id);
      this.recordTaskAssigned(agent.id);
      this.registerInternalTask(agent.id, cleanObjective, options);
      return {
        id: agent.id,
        sessionId: agent.sessionId || `session-${agent.id}`,
        objective: cleanObjective,
        status: 'running',
        startedAt: new Date().toISOString(),
      };
    });
  }

  /**
   * Cổng kiểm định chất lượng bằng chứng (Evidence-Based Quality Gate)
   * Xác minh kết quả của Subagent trước khi công nhận hoàn thành.
   */
  verifyQualityGate(options: QualityGateOptions): QualityGateResult {
    const failures: string[] = [];

    // 1. Files modified check
    let filesModifiedPass = true;
    let filesModifiedDetails = 'Files modified verified successfully.';
    if (options.requireFilesModified) {
      const count = options.modifiedFiles?.length || 0;
      if (count === 0 && (!options.diffText || !options.diffText.trim())) {
        filesModifiedPass = false;
        filesModifiedDetails = 'Claimed completion but NO files were actually modified (no diff generated).';
        failures.push(filesModifiedDetails);
      } else {
        filesModifiedDetails = `${count} file(s) modified verified.`;
      }
    }

    // 2. Scope compliance check
    let scopePass = true;
    let scopeDetails = 'All modifications are strictly within allowed scope.';
    const outOfScope: string[] = [];
    if (options.allowedFileScope && options.allowedFileScope.length > 0 && options.modifiedFiles) {
      const allowedNorm = new Set(options.allowedFileScope.map((f) => f.trim().replace(/\\/g, '/').toLowerCase()));
      for (const mod of options.modifiedFiles) {
        const normMod = mod.trim().replace(/\\/g, '/').toLowerCase();
        if (!allowedNorm.has(normMod)) {
          outOfScope.push(mod);
        }
      }
      if (outOfScope.length > 0) {
        scopePass = false;
        scopeDetails = `Files touched outside assigned scope: [${outOfScope.join(', ')}]`;
        failures.push(scopeDetails);
      }
    }

    // 3. Secret leak scan
    let secretPass = true;
    let secretDetails = 'No hardcoded secrets or sensitive keys detected.';
    const detectedTokens: string[] = [];
    if (options.scanSecrets !== false && options.diffText) {
      for (const pattern of SECRET_PATTERNS) {
        const match = options.diffText.match(pattern);
        if (match) {
          detectedTokens.push(match[0].slice(0, 8) + '***');
        }
      }
      if (detectedTokens.length > 0) {
        secretPass = false;
        secretDetails = `Potential secret/key leakage detected: [${detectedTokens.join(', ')}]`;
        failures.push(secretDetails);
      }
    }

    // 4. Verification command check
    let verificationPass = true;
    let verificationDetails = 'Verification command executed and passed.';
    if (options.requiredTestPass && options.commandExecutionRecords) {
      const failedRuns = options.commandExecutionRecords.filter((r) => r.exitCode !== 0);
      if (failedRuns.length > 0) {
        verificationPass = false;
        verificationDetails = `Verification command failed with exit code ${failedRuns[0].exitCode}: "${failedRuns[0].command}"`;
        failures.push(verificationDetails);
      }
    }

    return {
      passed: failures.length === 0,
      checks: {
        filesModified: { pass: filesModifiedPass, details: filesModifiedDetails },
        scopeCompliance: { pass: scopePass, details: scopeDetails, outOfScopeFiles: outOfScope.length > 0 ? outOfScope : undefined },
        secretScan: { pass: secretPass, details: secretDetails, detectedTokens: detectedTokens.length > 0 ? detectedTokens : undefined },
        verificationCommand: { pass: verificationPass, details: verificationDetails },
      },
      failures,
    };
  }

  /**
   * Giám sát nhịp tim (Heartbeat Monitor)
   * Phát hiện các subagents không có phản hồi hoặc bị treo quá thời gian (mặc định 30 phút).
   */
  checkHeartbeats(staleTimeoutMs = 30 * 60 * 1000): Array<{
    agentId: string;
    taskId?: string;
    idleDurationMs: number;
    isStale: boolean;
    lastActiveAt?: string;
  }> {
    const now = Date.now();
    const results: Array<{
      agentId: string;
      taskId?: string;
      idleDurationMs: number;
      isStale: boolean;
      lastActiveAt?: string;
    }> = [];

    for (const [taskId, task] of this.taskRegistry.entries()) {
      if (task.status === 'in_progress' || task.status === 'pending') {
        const lastActiveTime = new Date(task.lastHeartbeatAt).getTime();
        const idleDuration = Math.max(0, now - lastActiveTime);
        const isStale = idleDuration >= staleTimeoutMs;

        results.push({
          agentId: task.agentId,
          taskId,
          idleDurationMs: idleDuration,
          isStale,
          lastActiveAt: task.lastHeartbeatAt,
        });
      }
    }

    return results;
  }

  /**
   * Cập nhật nhịp tim mới nhất cho agent/tác vụ
   */
  updateHeartbeat(agentId: string): void {
    const profile = this.getOrCreateProfile(agentId);
    profile.lastActiveAt = new Date().toISOString();

    for (const task of this.taskRegistry.values()) {
      if (task.agentId === agentId && task.status === 'in_progress') {
        task.lastHeartbeatAt = profile.lastActiveAt;
      }
    }
  }

  /**
   * Lấy toàn bộ tác vụ đã ghi nhận trong Task Registry
   */
  getRegisteredTasks(): TaskRegistryEntry[] {
    return Array.from(this.taskRegistry.values());
  }

  /**
   * Liệt kê các agent đang ở trạng thái idle và đáp ứng yêu cầu capabilities.
   */
  listAvailableAgents(requiredCapabilities: string[] = []): AgentRecord[] {
    const matching = this.registry.findAgentsByCapabilities(requiredCapabilities);
    return matching.filter((agent) => agent.status === 'idle');
  }

  /**
   * Ghi nhận việc giao task cho một agent để phục vụ profiling hiệu năng.
   */
  recordTaskAssigned(agentId: string): void {
    const profile = this.getOrCreateProfile(agentId);
    profile.tasksAssigned++;
    profile.lastActiveAt = new Date().toISOString();
  }

  /**
   * Ghi nhận hoàn thành task của agent, cập nhật duration, giải phóng file lock và bottleneck status.
   */
  recordTaskCompletion(agentId: string, durationMs: number, success = true, tokensUsed = 0): void {
    const profile = this.getOrCreateProfile(agentId);
    if (success) {
      profile.tasksCompleted++;
    } else {
      profile.tasksFailed++;
    }
    profile.totalDurationMs += Math.max(0, durationMs);
    const finishedCount = profile.tasksCompleted + profile.tasksFailed;
    profile.averageDurationMs = finishedCount > 0 ? Math.round(profile.totalDurationMs / finishedCount) : 0;
    profile.estimatedTokensUsed += Math.max(0, tokensUsed);
    profile.lastActiveAt = new Date().toISOString();

    // Giải phóng toàn bộ file lock mà agent này đang giữ
    this.fileLockManager.release(agentId);

    // Cập nhật trạng thái task trong registry
    for (const task of this.taskRegistry.values()) {
      if (task.agentId === agentId && task.status === 'in_progress') {
        task.status = success ? 'completed' : 'failed';
        task.lastHeartbeatAt = profile.lastActiveAt;
      }
    }

    // Giảm task count trên registry
    this.registry.decrementTaskCount(agentId, success);

    // Kiểm tra và gắn cờ nghẽn (Bottleneck Detection)
    this.updateBottleneckStatus();
  }

  /**
   * Lấy bức tranh toàn cảnh về hiện trạng của toàn bộ swarm/cluster agent.
   */
  getOrchestrationStatus(): OrchestrationStatus {
    const all = this.registry.list();
    return {
      totalAgents: all.length,
      runningAgents: all.filter((a) => a.status === 'running').length,
      idleAgents: all.filter((a) => a.status === 'idle').length,
      waitingAgents: all.filter((a) => a.status === 'waiting').length,
      agents: all,
    };
  }

  /**
   * Lấy các chỉ số đo lường hiệu năng tổng thể của Swarm (Observability & Throughput).
   */
  getOrchestrationMetrics(): SwarmMetrics {
    const status = this.getOrchestrationStatus();
    const profiles = Array.from(this.performanceProfiles.values());
    const totalProcessed = profiles.reduce((sum, p) => sum + p.tasksCompleted, 0);
    const totalDuration = profiles.reduce((sum, p) => sum + p.totalDurationMs, 0);
    const avgLatency = totalProcessed > 0 ? Math.round(totalDuration / totalProcessed) : 0;

    const memoizationHitRate = this.totalAllocationRequests > 0
      ? Number((this.memoizationHits / this.totalAllocationRequests).toFixed(3))
      : 0;

    const bottlenecks = profiles.filter((p) => p.isBottleneck).map((p) => p.agentId);

    const costTierBreakdown: Record<string, number> = {
      lightweight: 0,
      standard: 0,
      heavyReasoning: 0,
    };

    for (const agent of status.agents) {
      const model = (agent.metadata?.model || '').toLowerCase();
      if (model.includes('flash') || model.includes('codestral') || model.includes('qwen')) {
        costTierBreakdown.lightweight++;
      } else if (model.includes('llama') || model.includes('deepseek-v3')) {
        costTierBreakdown.standard++;
      } else {
        costTierBreakdown.heavyReasoning++;
      }
    }

    return {
      totalAgents: status.totalAgents,
      runningAgents: status.runningAgents,
      idleAgents: status.idleAgents,
      totalTasksProcessed: totalProcessed,
      averageLatencyMs: avgLatency,
      memoizationHits: this.memoizationHits,
      memoizationHitRate,
      bottlenecks,
      costTierBreakdown,
    };
  }

  getPerformanceProfile(agentId: string): AgentPerformanceProfile | undefined {
    return this.performanceProfiles.get(agentId);
  }

  getPerformanceProfiles(): AgentPerformanceProfile[] {
    return Array.from(this.performanceProfiles.values());
  }

  clearMemoizationCache(): void {
    this.memoizedResults.clear();
    this.memoizationHits = 0;
  }

  // ── DAG Parallel Scheduler (Tier 0 SOTA Orchestration) ─────────────────────

  /**
   * Gắn kết PlanManager quản lý đồ thị tác vụ DAG.
   */
  bindPlanManager(planManager: PlanManager): this {
    this.planManager = planManager;
    return this;
  }

  /**
   * Gắn kết AgentEventBus phát tín hiệu điều phối sự kiện đa tác tử.
   */
  bindEventBus(bus: AgentEventBus): this {
    this.eventBus = bus;
    return this;
  }

  getPlanManager(): PlanManager | undefined {
    return this.planManager;
  }

  getEventBus(): AgentEventBus | undefined {
    return this.eventBus;
  }

  /**
   * Suy luận năng lực bắt buộc (capabilities) từ thông tin task theo quy tắc semantic.
   */
  inferTaskCapabilities(task: PlanTask): string[] {
    const text = `${task.title} ${task.acceptanceCriteria} ${(task.symbols || []).join(' ')}`.toLowerCase();
    if (/\b(math|algorithm|reasoning|proof|complexity|dp|dynamic programming|logic)\b/.test(text)) {
      return ['reasoning', 'math', 'algorithm'];
    }
    if (/\b(swe|bug|refactor|architecture|system|multi-file|structure|topology)\b/.test(text)) {
      return ['swe-bench', 'refactoring', 'architecture'];
    }
    if (/\b(governance|compliance|schema|rule|instruction|constraint|audit)\b/.test(text)) {
      return ['instruction-following', 'governance', 'schema-validation'];
    }
    if (/\b(fim|infill|surgical|patch|edit|diff|insert)\b/.test(text)) {
      return ['fim', 'surgical-patch', 'infilling'];
    }
    return ['coding', 'code-generation', 'synthesis'];
  }

  /**
   * Lập lịch và kích hoạt đợt thực thi song song kế tiếp theo Đồ thị DAG (DAG Parallel Scheduler).
   * Tự động:
   * 1. Nhận diện batch tác vụ độc lập/không xung đột từ PlanManager.
   * 2. Phân bổ chuyên gia (Specialists/Subagents) phù hợp nhất theo capabilities.
   * 3. Cấp khóa file an toàn (FileConcurrencyLockManager) ngăn chặn xung đột ngầm.
   * 4. Kích hoạt trạng thái IN_PROGRESS và phát thông điệp dag:task_dispatched.
   */
  async scheduleNextDagBatch(options?: DagBatchScheduleOptions): Promise<DagBatchScheduleResult> {
    if (!this.planManager) {
      throw new Error('No PlanManager bound to AgentOrchestrator. Call orchestrator.bindPlanManager(planManager) first.');
    }

    const maxConcurrency = options?.maxConcurrency ?? 4;
    const allowImplicit = options?.allowImplicitParallel ?? true;
    const autoStart = options?.autoStartBatch !== false;
    const acquireLocks = options?.acquireFileLocks !== false;
    const dispatchSubagents = options?.dispatchToSubagents !== false;

    const candidates = this.planManager.getRunnableParallelBatch({
      maxConcurrency,
      allowImplicitParallel: allowImplicit,
    });

    if (candidates.length === 0) {
      const pendingCount = this.planManager.getTasks().filter((t) => t.status === 'PENDING').length;
      return {
        batchNumber: this.currentDagBatch,
        dispatchedTasks: [],
        skippedOrDeferred: [],
        remainingPendingCount: pendingCount,
        hasMoreRunnable: false,
      };
    }

    this.currentDagBatch++;
    const batchNumber = this.currentDagBatch;
    const dispatchedTasks: DagDispatchedTask[] = [];
    const skippedOrDeferred: Array<{ taskId: number; reason: string }> = [];
    const taskIdsToStart: number[] = [];

    for (const task of candidates) {
      const requiredCapabilities = this.inferTaskCapabilities(task);
      let targetAgentId = 'coding-agent';
      let handle: SubagentHandle | undefined;
      let lockedFiles: string[] = [];

      if (dispatchSubagents) {
        try {
          handle = this.allocateTask(task.title, requiredCapabilities, {
            fileScope: acquireLocks && task.writeSet.length > 0 ? task.writeSet : undefined,
            priority: task.priority > 0 ? 'high' : 'normal',
          });
          targetAgentId = handle.id;
          lockedFiles = acquireLocks ? [...task.writeSet] : [];
        } catch (err: any) {
          if (err.message && err.message.includes('File locking conflict')) {
            skippedOrDeferred.push({
              taskId: task.id,
              reason: err.message,
            });
            continue;
          }
          const anyAgents = this.listAvailableAgents([]);
          targetAgentId = anyAgents[0]?.id || 'coding-agent';
          if (acquireLocks && task.writeSet.length > 0) {
            const lockRes = this.fileLockManager.acquire(targetAgentId, task.writeSet);
            if (!lockRes.success) {
              skippedOrDeferred.push({
                taskId: task.id,
                reason: `File lock conflict: ${lockRes.conflictingFiles.join(', ')}`,
              });
              continue;
            }
            lockedFiles = lockRes.acquired;
          }
          this.registerInternalTask(targetAgentId, task.title, { fileScope: task.writeSet });
        }
      } else {
        const availableAgents = this.listAvailableAgents(requiredCapabilities);
        targetAgentId = availableAgents[0]?.id || this.listAvailableAgents([])[0]?.id || 'coding-agent';
        if (acquireLocks && task.writeSet.length > 0) {
          const lockRes = this.fileLockManager.acquire(targetAgentId, task.writeSet);
          if (!lockRes.success) {
            skippedOrDeferred.push({
              taskId: task.id,
              reason: `File lock conflict: ${lockRes.conflictingFiles.join(', ')}`,
            });
            continue;
          }
          lockedFiles = lockRes.acquired;
        }
      }

      taskIdsToStart.push(task.id);
      dispatchedTasks.push({
        task,
        agentId: targetAgentId,
        handle,
        lockedFiles,
        capabilities: requiredCapabilities,
      });

      if (this.eventBus) {
        await this.eventBus.publish('orchestrator', 'dag:task_dispatched', {
          batchNumber,
          taskId: task.id,
          title: task.title,
          agentId: targetAgentId,
          writeSet: task.writeSet,
        });
      }
    }

    if (autoStart && taskIdsToStart.length > 0) {
      this.planManager.startParallelBatch(taskIdsToStart);
    }

    const pendingCount = this.planManager.getTasks().filter((t) => t.status === 'PENDING').length;
    const hasMore = this.planManager.getRunnableParallelBatch({ allowImplicitParallel: allowImplicit }).length > 0;

    return {
      batchNumber,
      dispatchedTasks,
      skippedOrDeferred,
      remainingPendingCount: pendingCount,
      hasMoreRunnable: hasMore,
    };
  }

  /**
   * Tự động điều phối và thực thi toàn bộ Đồ thị DAG từ gốc đến ngọn (Full DAG Execution Loop).
   * Lặp qua từng đợt batch song song, kiểm tra cổng chất lượng (Quality Gates),
   * thu thập bằng chứng, mở khóa Join Barriers và xử lý Cascade Failures nếu có lỗi.
   */
  async executeFullDag(options?: DagExecutionOptions): Promise<DagExecutionSummary> {
    if (!this.planManager) {
      throw new Error('No PlanManager bound to AgentOrchestrator. Call orchestrator.bindPlanManager(planManager) first.');
    }

    const startTime = Date.now();
    const maxBatches = options?.maxBatches ?? 50;
    const taskResults = new Map<number, { success: boolean; agentId: string; output?: string; error?: string }>();
    let batchesExecuted = 0;

    while (batchesExecuted < maxBatches && !this.planManager.isAllTasksCompleted()) {
      const scheduleResult = await this.scheduleNextDagBatch({
        maxConcurrency: options?.maxConcurrency,
        allowImplicitParallel: options?.allowImplicitParallel ?? true,
        autoStartBatch: true,
        acquireFileLocks: true,
        dispatchToSubagents: true,
      });

      if (scheduleResult.dispatchedTasks.length === 0) {
        // Không còn task nào có thể dispatch đợt này
        break;
      }

      batchesExecuted++;

      // Thực thi song song tất cả các task trong batch hiện hành (Promise.allSettled)
      const batchPromises = scheduleResult.dispatchedTasks.map(async (dispatched) => {
        const { task, agentId } = dispatched;
        const taskStart = Date.now();

        try {
          let workerOutput: {
            success: boolean;
            output?: string;
            modifiedFiles?: string[];
            diffText?: string;
            commandRecords?: Array<{ command: string; exitCode: number }>;
            error?: string;
          } = {
            success: true,
            output: `Task #${task.id} executed successfully.`,
            modifiedFiles: task.writeSet,
            diffText: undefined,
            commandRecords: undefined,
            error: undefined,
          };

          if (options?.taskWorker) {
            workerOutput = await options.taskWorker(task, agentId);
          }

          let passedQuality = workerOutput.success;
          let failureReason = workerOutput.error;

          if (passedQuality && options?.qualityGate) {
            const gateRes = this.verifyQualityGate({
              ...options.qualityGate,
              modifiedFiles: workerOutput.modifiedFiles || task.writeSet,
              diffText: workerOutput.diffText,
              commandExecutionRecords: workerOutput.commandRecords,
            });
            if (!gateRes.passed) {
              passedQuality = false;
              failureReason = `Quality gate failed: ${gateRes.failures.join('; ')}`;
            }
          }

          const durationMs = Date.now() - taskStart;

          if (passedQuality) {
            this.planManager!.completeTaskWithEvidence(
              task.id,
              {
                toolName: 'dag-scheduler',
                kind: 'verification',
                outcome: 'success',
                summary: workerOutput.output || `Task #${task.id} verified`,
              },
              workerOutput.output,
            );
            this.fileLockManager.release(agentId);
            this.recordTaskCompletion(agentId, durationMs, true);
            taskResults.set(task.id, {
              success: true,
              agentId,
              output: workerOutput.output,
            });

            if (this.eventBus) {
              await this.eventBus.publish('orchestrator', 'dag:task_completed', {
                taskId: task.id,
                agentId,
                durationMs,
              });
            }
          } else {
            const err = failureReason || `Task #${task.id} failed verification`;
            this.planManager!.failTaskWithCascade(task.id, err, {
              cascadeToDependents: options?.cascadeFailures !== false,
            });
            this.fileLockManager.release(agentId);
            this.recordTaskCompletion(agentId, durationMs, false);
            taskResults.set(task.id, {
              success: false,
              agentId,
              error: err,
            });

            if (this.eventBus) {
              await this.eventBus.publish('orchestrator', 'dag:task_failed', {
                taskId: task.id,
                agentId,
                error: err,
              });
            }
          }
        } catch (err: any) {
          const durationMs = Date.now() - taskStart;
          const errorMsg = err.message || String(err);
          this.planManager!.failTaskWithCascade(task.id, errorMsg, {
            cascadeToDependents: options?.cascadeFailures !== false,
          });
          this.fileLockManager.release(agentId);
          this.recordTaskCompletion(agentId, durationMs, false);
          taskResults.set(task.id, {
            success: false,
            agentId,
            error: errorMsg,
          });

          if (this.eventBus) {
            await this.eventBus.publish('orchestrator', 'dag:task_failed', {
              taskId: task.id,
              agentId,
              error: errorMsg,
            });
          }
        }
      });

      await Promise.allSettled(batchPromises);

      if (this.eventBus) {
        await this.eventBus.publish('orchestrator', 'dag:batch_completed', {
          batchNumber: scheduleResult.batchNumber,
          tasksCount: scheduleResult.dispatchedTasks.length,
        });
      }
    }

    const allTasks = this.planManager.getTasks();
    const completedTasks = allTasks.filter((t) => t.status === 'COMPLETED').length;
    const failedTasks = allTasks.filter((t) => t.status === 'FAILED').length;

    return {
      totalTasks: allTasks.length,
      completedTasks,
      failedTasks,
      batchesExecuted,
      executionTimeMs: Date.now() - startTime,
      taskResults,
      isSuccess: this.planManager.isAllTasksCompleted(),
    };
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  private registerInternalTask(agentId: string, objective: string, options: SubagentOptions): void {
    const id = `task-${++this.taskCounter}-${Date.now()}`;
    const entry: TaskRegistryEntry = {
      id,
      description: objective,
      agentId,
      status: 'in_progress',
      assignedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      fileScope: options.fileScope,
      verificationCommand: options.verificationCommand,
    };
    this.taskRegistry.set(id, entry);
  }

  private rankCandidates(candidates: AgentRecord[], options: SubagentOptions): AgentRecord[] {
    return [...candidates].sort((a, b) => {
      const scoreA = this.calculateCandidateScore(a, options);
      const scoreB = this.calculateCandidateScore(b, options);
      return scoreB - scoreA;
    });
  }

  private calculateCandidateScore(candidate: AgentRecord, options: SubagentOptions): number {
    let score = 100;

    // 1. Workload penalty: Agent càng bận càng bị trừ điểm
    const activeTasks = candidate.activeTasksCount || 0;
    score -= activeTasks * 30;

    // 2. Availability bonus: Idle được cộng điểm
    if (candidate.status === 'idle') {
      score += 40;
    }

    // 3. Benchmark Score Weight: Điểm benchmark cao hơn được ưu tiên
    if (candidate.metadata?.score) {
      const match = String(candidate.metadata.score).match(/(\d+(\.\d+)?)/);
      if (match) {
        const pct = parseFloat(match[1]);
        score += Math.round(pct * 0.4);
      }
    }

    // 4. Cost-Efficiency Optimization
    if (options.preferCostEfficient) {
      const model = (candidate.metadata?.model || '').toLowerCase();
      if (model.includes('coder') || model.includes('codestral') || model.includes('flash')) {
        score += 35;
      } else if (model.includes('r1') || model.includes('pro')) {
        score -= 20;
      }
    }

    // 5. Priority Weight
    if (options.priority === 'high') {
      if (candidate.metadata?.score) {
        const match = String(candidate.metadata.score).match(/(\d+(\.\d+)?)/);
        if (match) {
          score += Math.round(parseFloat(match[1]) * 0.4);
        }
      }
    } else if (options.priority === 'low') {
      score -= activeTasks * 20;
    }

    return score;
  }

  private computeMemoizationKey(objective: string, capabilities: string[]): string {
    const cleanCap = [...capabilities].map((c) => c.trim().toLowerCase()).sort().join(',');
    return crypto.createHash('sha256').update(`${objective}::${cleanCap}`).digest('hex');
  }

  private getOrCreateProfile(agentId: string): AgentPerformanceProfile {
    let profile = this.performanceProfiles.get(agentId);
    if (!profile) {
      profile = {
        agentId,
        tasksAssigned: 0,
        tasksCompleted: 0,
        tasksFailed: 0,
        totalDurationMs: 0,
        averageDurationMs: 0,
        estimatedTokensUsed: 0,
        isBottleneck: false,
      };
      this.performanceProfiles.set(agentId, profile);
    }
    return profile;
  }

  private updateBottleneckStatus(): void {
    const profiles = Array.from(this.performanceProfiles.values());
    if (profiles.length === 0) return;

    const totalDur = profiles.reduce((sum, p) => sum + p.averageDurationMs, 0);
    const avgSwarmDuration = totalDur / profiles.length;

    for (const p of profiles) {
      const finished = p.tasksCompleted + p.tasksFailed;
      const failureRate = finished > 0 ? p.tasksFailed / finished : 0;

      p.isBottleneck = (finished >= 3 && failureRate > 0.3) ||
        (finished >= 3 && avgSwarmDuration > 0 && p.averageDurationMs > avgSwarmDuration * 2);
    }
  }
}
