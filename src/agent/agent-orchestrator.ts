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
 * Coordinated Multi-Agent Performance Profiler & Orchestrator.
 * Implements workload distribution, dynamic scoring, cost-aware routing, and result memoization.
 */
export class AgentOrchestrator {
  private performanceProfiles = new Map<string, AgentPerformanceProfile>();
  private memoizedResults = new Map<string, MemoizedResult>();
  private memoizationHits = 0;
  private totalAllocationRequests = 0;

  constructor(
    private readonly registry: AgentRegistry,
    private readonly subagentManager?: SubagentManager,
    private readonly memoizationTtlMs = 5 * 60 * 1000, // 5 minutes
  ) {}

  /**
   * Phân bổ một nhiệm vụ cho agent phù hợp nhất dựa trên capabilities và tối ưu hóa tải/hiệu năng.
   */
  allocateTask(objective: string, requiredCapabilities: string[] = [], options: SubagentOptions = {}): SubagentHandle {
    const cleanObjective = objective.trim();
    if (!cleanObjective) throw new Error('Task objective must not be empty.');

    this.totalAllocationRequests++;

    // 1. Result Memoization: Kiểm tra cache nếu bật tùy chọn memoize
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
      return handle;
    }

    // 2. Tìm danh sách ứng viên
    const candidates = this.listAvailableAgents(requiredCapabilities);
    if (candidates.length === 0) {
      throw new Error(`No available agent found matching required capabilities: ${requiredCapabilities.join(', ')}`);
    }

    // 3. Workload Distribution & Multi-Factor Scoring
    const rankedCandidates = this.rankCandidates(candidates, options);
    const selected = rankedCandidates[0];

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

    // Sắp xếp các ứng viên theo tải tăng dần để cân bằng tải
    const sorted = [...candidates].sort((a, b) => (a.activeTasksCount || 0) - (b.activeTasksCount || 0));

    return sorted.map((agent) => {
      this.registry.incrementTaskCount(agent.id);
      this.recordTaskAssigned(agent.id);
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
   * Ghi nhận hoàn thành task của agent, cập nhật duration, token usage và bottleneck status.
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

  /**
   * Lấy hồ sơ hiệu năng của một agent cụ thể hoặc toàn bộ swarm.
   */
  getPerformanceProfile(agentId: string): AgentPerformanceProfile | undefined {
    return this.performanceProfiles.get(agentId);
  }

  getPerformanceProfiles(): AgentPerformanceProfile[] {
    return Array.from(this.performanceProfiles.values());
  }

  /**
   * Xóa toàn bộ bộ nhớ đệm kết quả memoization.
   */
  clearMemoizationCache(): void {
    this.memoizedResults.clear();
    this.memoizationHits = 0;
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

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
        score += Math.round(pct * 0.4); // e.g. 97.3% -> +39 điểm
      }
    }

    // 4. Cost-Efficiency Optimization
    if (options.preferCostEfficient) {
      const model = (candidate.metadata?.model || '').toLowerCase();
      if (model.includes('coder') || model.includes('codestral') || model.includes('flash')) {
        score += 35; // Model nhanh/rẻ được cộng điểm
      } else if (model.includes('r1') || model.includes('pro')) {
        score -= 20; // Model nặng/đắt bị trừ điểm khi yêu cầu cost efficient
      }
    }

    // 5. Priority Weight
    if (options.priority === 'high') {
      // Ưu tiên chất lượng tối đa: Nhân đôi điểm benchmark
      if (candidate.metadata?.score) {
        const match = String(candidate.metadata.score).match(/(\d+(\.\d+)?)/);
        if (match) {
          score += Math.round(parseFloat(match[1]) * 0.4);
        }
      }
    } else if (options.priority === 'low') {
      // Ưu tiên tải nhẹ nhất
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

      // Bottleneck nếu tỷ lệ lỗi > 30% hoặc độ trễ gấp đôi trung bình của cả swarm
      p.isBottleneck = (finished >= 3 && failureRate > 0.3) ||
        (finished >= 3 && avgSwarmDuration > 0 && p.averageDurationMs > avgSwarmDuration * 2);
    }
  }
}
