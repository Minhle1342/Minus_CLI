export type AgentStatus = 'idle' | 'running' | 'waiting' | 'error' | 'stopped';

export interface AgentRecord {
  id: string;
  label: string;
  status: AgentStatus;
  sessionId?: string;
  turn?: number;
  step?: number;
  capabilities?: string[];
  metadata?: Record<string, any>;
  activeTasksCount?: number;
  totalTasksCompleted?: number;
  lastActiveAt?: string;
  updatedAt: string;
}

/** Live registry for agents composed into one Kernel. */
export class AgentRegistry {
  private agents = new Map<string, AgentRecord>();

  register(id: string, label = id, metadata?: Record<string, any>): AgentRecord {
    if (!id.trim()) throw new Error('Agent id must not be empty.');
    const existing = this.agents.get(id);
    if (existing) {
      if (metadata) {
        return this.update(id, { metadata: { ...existing.metadata, ...metadata } });
      }
      return { ...existing };
    }

    const record: AgentRecord = {
      id,
      label,
      status: 'idle',
      metadata: metadata ? { ...metadata } : undefined,
      updatedAt: new Date().toISOString(),
    };
    this.agents.set(id, record);
    return { ...record };
  }

  unregister(id: string): boolean {
    return this.agents.delete(id);
  }

  update(id: string, changes: Partial<Omit<AgentRecord, 'id'>>): AgentRecord {
    const current = this.agents.get(id) || this.register(id);
    const updated: AgentRecord = {
      ...current,
      ...changes,
      id,
      updatedAt: new Date().toISOString(),
    };
    this.agents.set(id, updated);
    return { ...updated };
  }

  get(id: string): AgentRecord | undefined {
    const record = this.agents.get(id);
    return record ? { ...record } : undefined;
  }

  list(): AgentRecord[] {
    return Array.from(this.agents.values()).map((record) => ({ ...record }));
  }

  /**
   * Tăng số lượng tác vụ đang xử lý (active tasks) của một agent để giám sát tải.
   */
  incrementTaskCount(id: string): AgentRecord {
    const current = this.get(id);
    const count = (current?.activeTasksCount || 0) + 1;
    return this.update(id, {
      activeTasksCount: count,
      status: 'running',
      lastActiveAt: new Date().toISOString(),
    });
  }

  /**
   * Giảm số lượng tác vụ khi hoàn tất và ghi nhận số lượng tác vụ đã xong.
   */
  decrementTaskCount(id: string, success = true): AgentRecord {
    const current = this.get(id);
    const active = Math.max(0, (current?.activeTasksCount || 1) - 1);
    const completed = (current?.totalTasksCompleted || 0) + (success ? 1 : 0);
    return this.update(id, {
      activeTasksCount: active,
      totalTasksCompleted: completed,
      status: active === 0 ? 'idle' : 'running',
      lastActiveAt: new Date().toISOString(),
    });
  }

  /**
   * Quảng bá các năng lực (capabilities/skills) của một agent vào registry.
   */
  advertiseCapabilities(id: string, capabilities: string[]): AgentRecord {
    const cleanCapabilities = Array.from(new Set(capabilities.map((c) => c.trim()).filter(Boolean)));
    return this.update(id, { capabilities: cleanCapabilities });
  }

  /**
   * Lấy danh sách capabilities của một agent.
   */
  getCapabilities(id: string): string[] {
    const record = this.agents.get(id);
    return record?.capabilities ? [...record.capabilities] : [];
  }

  /**
   * Tìm kiếm tất cả các agents đáp ứng toàn bộ danh sách capabilities yêu cầu.
   */
  findAgentsByCapabilities(capabilities: string[]): AgentRecord[] {
    if (capabilities.length === 0) return this.list();
    const cleanReqs = capabilities.map((c) => c.trim().toLowerCase()).filter(Boolean);
    return this.list().filter((agent) => {
      if (!agent.capabilities || agent.capabilities.length === 0) return false;
      const agentCaps = agent.capabilities.map((c) => c.toLowerCase());
      return cleanReqs.every((req) => agentCaps.includes(req));
    });
  }

  /**
   * Tìm kiếm tất cả các agents sở hữu một capability cụ thể.
   */
  findAgentsByCapability(capability: string): AgentRecord[] {
    const clean = capability.trim();
    if (!clean) return this.list();
    return this.findAgentsByCapabilities([clean]);
  }

  /**
   * Đăng ký các Subagent chuyên gia theo các Benchmark cao nhất của các LLMs.
   */
  registerBenchmarkSpecialists(): AgentRecord[] {
    return registerBenchmarkSpecialists(this);
  }
}

import { registerBenchmarkSpecialists } from './benchmark-agents.js';

