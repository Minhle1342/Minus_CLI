export type AgentStatus = 'idle' | 'running' | 'waiting' | 'error' | 'stopped';

export interface AgentRecord {
  id: string;
  label: string;
  status: AgentStatus;
  sessionId?: string;
  turn?: number;
  step?: number;
  capabilities?: string[];
  updatedAt: string;
}

/** Live registry for agents composed into one Kernel. */
export class AgentRegistry {
  private agents = new Map<string, AgentRecord>();

  register(id: string, label = id): AgentRecord {
    if (!id.trim()) throw new Error('Agent id must not be empty.');
    const existing = this.agents.get(id);
    if (existing) return { ...existing };

    const record: AgentRecord = {
      id,
      label,
      status: 'idle',
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
}
