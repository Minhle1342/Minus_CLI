import { AgentRegistry } from './agent-registry.js';
import { SubagentManager, SubagentOptions, SubagentHandle } from './subagent-manager.js';

/**
 * Orchestrates task allocation across multiple agents based on capabilities.
 * Bridges high-level task delegation to SubagentManager.
 */
export class AgentOrchestrator {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly subagentManager?: SubagentManager,
  ) {}

  allocateTask(objective: string, requiredCapabilities: string[] = [], options: SubagentOptions = {}): SubagentHandle {
    if (this.subagentManager) {
      return this.subagentManager.allocateTask(objective, requiredCapabilities, options);
    }

    const available = this.registry.list().find((agent) => {
      if (agent.status !== 'idle') return false;
      if (requiredCapabilities.length === 0) return true;
      return agent.capabilities && requiredCapabilities.every((cap) => agent.capabilities!.includes(cap));
    });

    if (!available) {
      throw new Error(`No available agent found matching required capabilities: ${requiredCapabilities.join(', ')}`);
    }

    return {
      id: available.id,
      sessionId: available.sessionId || `session-${available.id}`,
      objective,
      status: available.status === 'idle' ? 'running' : 'running',
      startedAt: new Date().toISOString(),
    };
  }
}
