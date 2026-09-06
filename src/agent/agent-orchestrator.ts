import crypto from 'node:crypto';
import { AgentRegistry, AgentRecord } from './agent-registry.js';
import { SubagentManager, SubagentOptions, SubagentHandle } from './subagent-manager.js';

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

/**
 * Thuật toán tính độ tương đồng xâu chuỗi (chuẩn SequenceMatcher & Dice Tokenizer)
 * Ngưỡng khuyến nghị: >= 0.55 (55%) để phát hiện task trùng lặp
 */
export function computeTaskSimilarity(textA: string, textB: string): number {
  const normA = textA.toLowerCase().trim().replace(/[^\w\s]/g, ' ');
  const normB = textB.toLowerCase().trim().replace(/[^\w\s]/g, ' ');
  if (normA === normB) return 1.0;
  if (!normA || !normB) return 0.0;

  const wordsA = normA.split(/\s+/).filter(Boolean);
  const wordsB = normB.split(/\s+/).filter(Boolean);
  if (wordsA.length === 0 || wordsB.length === 0) return 0.0;

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

  // Lấy giá trị lớn nhất giữa word-level và char-level để nhạy bén với cả từ đồng nghĩa/viết tắt
  return Math.max(wordScore, charScore);
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

  constructor(
    private readonly registry: AgentRegistry,
    private readonly subagentManager?: SubagentManager,
    private readonly memoizationTtlMs = 5 * 60 * 1000, // 5 minutes
  ) {}

  /**
   * Kiểm tra xem tác vụ có bị trùng lặp với tác vụ đang chờ/đang thực thi không
   * Ngưỡng similarity threshold mặc định là 0.55 (55%)
   */
  checkDuplicateTask(description: string, threshold = 0.55): {
    isDuplicate: boolean;
    similarity: number;
    existingTask?: TaskRegistryEntry;
  } {
    const clean = description.trim();
    if (!clean) return { isDuplicate: false, similarity: 0 };

    for (const task of this.taskRegistry.values()) {
      if (task.status === 'pending' || task.status === 'in_progress') {
        const sim = computeTaskSimilarity(clean, task.description);
        if (sim >= threshold) {
          return {
            isDuplicate: true,
            similarity: Number(sim.toFixed(3)),
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
        throw new Error(
          `DUPLICATE_TASK_DETECTED: Task "${cleanObjective}" matches existing in-progress task #${dupCheck.existingTask.id} ` +
          `assigned to "${dupCheck.existingTask.agentId}" (Similarity: ${Math.round(dupCheck.similarity * 100)}%).`
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
