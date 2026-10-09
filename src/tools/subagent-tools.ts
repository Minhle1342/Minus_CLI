import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { SubagentManager } from '../agent/subagent-manager.js';
import { AgentOrchestrator } from '../agent/agent-orchestrator.js';
import { MultiAgentBrainstormingEngine } from '../agent/multi-agent-brainstorming.js';
import { Workspace } from '../workspace/workspace.js';

export function createDelegateAgentTool(manager: SubagentManager): ToolDefinition {
  return {
    name: 'delegate_agent',
    description: 'Launch a background subagent for an independent task; returns an agentId to poll for results.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        objective: { type: Type.STRING, description: 'Independent objective for the subagent to perform.' },
        maxSteps: { type: Type.INTEGER, description: 'Subagent step limit (agent default).' },
        toolNames: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Optional tool allowlist for the subagent.' },
        fileScope: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Scope of files allowed to change (safe file locking to avoid concurrent conflicts).' },
        verificationCommand: { type: Type.STRING, description: 'Test command to verify results when the subagent completes.' },
      },
      required: ['objective'],
    },
    async execute(args: Record<string, any>, _workspace: Workspace): Promise<Record<string, any>> {
      const objective = String(args.objective || '').trim();
      if (!objective) return { error: 'The "objective" parameter is required.' };
      const handle = manager.start(objective, {
        maxSteps: typeof args.maxSteps === 'number' ? args.maxSteps : undefined,
        toolNames: Array.isArray(args.toolNames) ? args.toolNames.map(String) : undefined,
        fileScope: Array.isArray(args.fileScope) ? args.fileScope.map(String) : undefined,
        verificationCommand: typeof args.verificationCommand === 'string' ? args.verificationCommand : undefined,
      });
      return { success: true, agent: handle };
    },
  };
}

export function createDelegateTaskTool(manager: SubagentManager): ToolDefinition {
  return {
    name: 'delegate_task',
    description: 'Synchronously delegate an independent, bounded subtask to an isolated subagent. Runs in a separate in-memory session and returns a compact summary with touched files, preventing parent context pollution.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        task: {
          type: Type.STRING,
          description: 'Clear description of the subtask to perform.',
        },
        allowedTools: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Optional list of allowed tool names (e.g. ["read_file", "search_files", "run_command"]).',
        },
        maxSteps: {
          type: Type.INTEGER,
          description: 'Maximum step budget for this subtask (default: 6).',
        },
        verificationCommand: {
          type: Type.STRING,
          description: 'Optional verification command to execute before finishing.',
        },
      },
      required: ['task'],
    },
    async execute(args: Record<string, any>, _workspace: Workspace, context?: any): Promise<Record<string, any>> {
      const task = String(args.task || '').trim();
      if (!task) return { error: 'The "task" parameter is required.' };
      const maxSteps = typeof args.maxSteps === 'number' ? args.maxSteps : 6;
      const allowedTools = Array.isArray(args.allowedTools) ? args.allowedTools.map(String) : undefined;
      const verificationCommand = typeof args.verificationCommand === 'string' ? args.verificationCommand : undefined;

      const result = await manager.executeIsolatedTask(task, {
        maxSteps,
        allowedTools,
        verificationCommand,
        signal: context?.signal,
      });

      return result;
    },
  };
}

export function createSpawnAgentTool(manager: SubagentManager): ToolDefinition {
  return {
    name: 'spawn_agent',
    description: 'Spawn a clean-context child agent with an explicit task brief and scoped capabilities.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        brief: { type: Type.STRING, description: 'Detailed prompt brief and task instructions for the child agent.' },
        maxSteps: { type: Type.INTEGER, description: 'Maximum step budget for the child agent.' },
        toolNames: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Optional list of allowed tool names.' },
        worktreePath: { type: Type.STRING, description: 'Optional isolated worktree path for this agent.' },
      },
      required: ['brief'],
    },
    async execute(args: Record<string, any>, _workspace: Workspace): Promise<Record<string, any>> {
      const brief = String(args.brief || '').trim();
      if (!brief) return { error: 'Param "brief" is required.' };
      const handle = manager.spawn(brief, {
        maxSteps: typeof args.maxSteps === 'number' ? args.maxSteps : undefined,
        toolNames: Array.isArray(args.toolNames) ? args.toolNames.map(String) : undefined,
        worktreePath: args.worktreePath ? String(args.worktreePath) : undefined,
      });
      return { success: true, agentId: handle.id, agent: handle };
    },
  };
}

export function createWaitAgentTool(manager: SubagentManager): ToolDefinition {
  return {
    name: 'wait_agent',
    description: 'Wait for a subagent to complete with a safe event-driven timeout (no resource-wasting polling).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        agentId: {
          type: Type.STRING,
          description: 'ID of the subagent to wait for.',
        },
        timeoutMs: {
          type: Type.INTEGER,
          description: 'Maximum wait time in milliseconds (default: 60000ms = 60s).',
        },
      },
      required: ['agentId'],
    },
    async execute(args: Record<string, any>, _workspace: Workspace): Promise<Record<string, any>> {
      const agentId = String(args.agentId || '').trim();
      if (!agentId) return { error: 'The "agentId" parameter is required.' };
      const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 60000;
      try {
        const handle = await manager.waitFor(agentId, timeoutMs);
        return {
          success: true,
          agent: handle,
          completed: handle.status === 'completed',
          answer: handle.answer,
        };
      } catch (err: any) {
        return { success: false, error: err.message, agentId };
      }
    },
  };
}

export function createGetAgentResultTool(manager: SubagentManager): ToolDefinition {
  return {
    name: 'get_agent_result',
    description: 'Read the current status and result of a delegated subagent.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        agentId: { type: Type.STRING, description: 'ID of the subagent to check.' },
      },
      required: ['agentId'],
    },
    async execute(args: Record<string, any>, _workspace: Workspace): Promise<Record<string, any>> {
      const agentId = String(args.agentId || '').trim();
      if (!agentId) return { error: 'The "agentId" parameter is required.' };
      const agent = manager.get(agentId);
      return agent ? { success: true, agent } : { success: false, error: 'SUBAGENT_NOT_FOUND', agentId };
    },
  };
}

export function createStopAgentTool(manager: SubagentManager): ToolDefinition {
  return {
    name: 'stop_agent',
    description: 'Request stopping a running subagent.',
    parameters: {
      type: Type.OBJECT,
      properties: { agentId: { type: Type.STRING, description: 'ID of the subagent to stop.' } },
      required: ['agentId'],
    },
    async execute(args: Record<string, any>, _workspace: Workspace): Promise<Record<string, any>> {
      const agentId = String(args.agentId || '').trim();
      if (!agentId) return { error: 'The "agentId" parameter is required.' };
      const stopped = manager.stop(agentId);
      return { success: stopped, agentId };
    },
  };
}

export function createResumeAgentTool(manager: SubagentManager): ToolDefinition {
  return {
    name: 'resume_agent',
    description: 'Resume a stopped/failed subagent after the operator confirms a re-run.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        agentId: { type: Type.STRING, description: 'ID of the subagent to resume.' },
        maxSteps: { type: Type.INTEGER, description: 'Additional step budget for the resume pass.' },
        toolNames: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Optional tool allowlist.' },
      },
      required: ['agentId'],
    },
    async execute(args: Record<string, any>, _workspace: Workspace): Promise<Record<string, any>> {
      const agentId = String(args.agentId || '').trim();
      if (!agentId) return { error: 'The "agentId" parameter is required.' };
      const agent = manager.resume(agentId, {
        maxSteps: typeof args.maxSteps === 'number' ? args.maxSteps : undefined,
        toolNames: Array.isArray(args.toolNames) ? args.toolNames.map(String) : undefined,
      });
      return agent
        ? { success: true, agent }
        : { success: false, error: 'SUBAGENT_NOT_RESUMABLE', agentId };
    },
  };
}

export function createAllocateAgentTaskTool(orchestrator: AgentOrchestrator): ToolDefinition {
  return {
    name: 'allocate_agent_task',
    description: 'Assign and coordinate a task to a suitable agent based on capability matching, with anti-duplication and safe file locking.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        objective: {
          type: Type.STRING,
          description: 'Independent objective to perform.',
        },
        requiredCapabilities: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'List of required agent capabilities (e.g. ["frontend", "react"], ["database", "sql"]).',
        },
        maxSteps: {
          type: Type.INTEGER,
          description: 'Step budget for agent execution.',
        },
        toolNames: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'List of allowed tools.',
        },
        fileScope: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Scope of files allowed to change (file locking to avoid concurrent conflicts).',
        },
        checkAntiDuplication: {
          type: Type.BOOLEAN,
          description: 'Anti-duplication check against executing/pending tasks (threshold >= 55%).',
        },
        priority: {
          type: Type.STRING,
          description: 'Task priority: "high" (max quality), "normal", "low" (save cost/load).',
        },
        preferCostEfficient: {
          type: Type.BOOLEAN,
          description: 'If true, prefer low-cost, high-speed models.',
        },
        memoize: {
          type: Type.BOOLEAN,
          description: 'If true, save and reuse results in cache when repeating the same objective.',
        },
      },
      required: ['objective'],
    },
    async execute(args: Record<string, any>, _workspace: Workspace): Promise<Record<string, any>> {
      const objective = String(args.objective || '').trim();
      if (!objective) return { error: 'The "objective" parameter is required.' };
      const requiredCapabilities = Array.isArray(args.requiredCapabilities)
        ? args.requiredCapabilities.map(String)
        : [];
      try {
        const handle = orchestrator.allocateTask(objective, requiredCapabilities, {
          maxSteps: typeof args.maxSteps === 'number' ? args.maxSteps : undefined,
          toolNames: Array.isArray(args.toolNames) ? args.toolNames.map(String) : undefined,
          fileScope: Array.isArray(args.fileScope) ? args.fileScope.map(String) : undefined,
          checkAntiDuplication: args.checkAntiDuplication === true,
          priority: args.priority === 'high' || args.priority === 'low' ? args.priority : undefined,
          preferCostEfficient: args.preferCostEfficient === true,
          memoize: args.memoize === true,
        });
        return { success: true, agent: handle };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  };
}

export function createBrainstormDesignTool(engine?: MultiAgentBrainstormingEngine): ToolDefinition {
  const bEngine = engine || new MultiAgentBrainstormingEngine();
  return {
    name: 'brainstorm_design',
    description: 'Run a controlled sequential multi-agent design review (Structured Peer-Review) with 5 personas (Primary Designer, Skeptic, Constraint Guardian, User Advocate, Integrator/Arbiter) and a decision log.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        goal: { type: Type.STRING, description: 'Design goal to review.' },
        initialDesign: { type: Type.STRING, description: 'Initial design summary, if any.' },
      },
      required: ['goal'],
    },
    async execute(args: Record<string, any>, _workspace: Workspace): Promise<Record<string, any>> {
      const goal = String(args.goal || '').trim();
      if (!goal) return { error: 'The "goal" parameter is required.' };
      try {
        const result = await bEngine.runReview(goal, args.initialDesign);
        const decisionLogMarkdown = bEngine.renderDecisionLogMarkdown(result);
        return {
          success: true,
          disposition: result.finalDisposition,
          exitCriteriaMet: result.exitCriteriaMet,
          decisionLog: result.decisionLog,
          decisionLogMarkdown,
          arbiterRationale: result.arbiterRationale,
          actions: result.actionRequired,
        };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  };
}

export function createVerifySubagentQualityTool(orchestrator: AgentOrchestrator): ToolDefinition {
  return {
    name: 'verify_subagent_quality',
    description: 'Evidence-based quality gate for subagent results.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        agentId: { type: Type.STRING, description: 'ID of the subagent to audit.' },
        requireFilesModified: { type: Type.BOOLEAN, description: 'Require files to have actually changed on disk.' },
        allowedFileScope: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'List of files allowed to change.' },
        modifiedFiles: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'List of files actually changed.' },
        diffText: { type: Type.STRING, description: 'Unified diff content to scan for secret leaks.' },
        scanSecrets: { type: Type.BOOLEAN, description: 'Enable scanning for leaked keys/secrets.' },
      },
      required: ['agentId'],
    },
    async execute(args: Record<string, any>, _workspace: Workspace): Promise<Record<string, any>> {
      const res = orchestrator.verifyQualityGate({
        requireFilesModified: args.requireFilesModified !== false,
        allowedFileScope: Array.isArray(args.allowedFileScope) ? args.allowedFileScope.map(String) : undefined,
        modifiedFiles: Array.isArray(args.modifiedFiles) ? args.modifiedFiles.map(String) : undefined,
        diffText: typeof args.diffText === 'string' ? args.diffText : undefined,
        scanSecrets: args.scanSecrets !== false,
      });
      return { success: res.passed, qualityGate: res };
    },
  };
}

export function createScheduleDagParallelTool(orchestrator: AgentOrchestrator): ToolDefinition {
  return {
    name: 'schedule_dag_parallel',
    description: 'Schedule and trigger parallel execution via a DAG (DAG Parallel Scheduler) for PlanManager & AgentOrchestrator. Supports running the next batch ("next_batch"), the whole graph ("full_dag"), or status checks ("status").',
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: {
          type: Type.STRING,
          description: 'Action to perform: "next_batch" (default: trigger the next batch), "full_dag" (run the whole graph automatically), or "status" (check runnable batches and DAG state).',
        },
        maxConcurrency: {
          type: Type.INTEGER,
          description: 'Maximum number of tasks to execute in parallel in one batch (default: 4).',
        },
        allowImplicitParallel: {
          type: Type.BOOLEAN,
          description: 'If true, independent tasks without an explicit parallelizable declaration are still parallelized when there are no Read/Write set conflicts (default: true).',
        },
        autoStartBatch: {
          type: Type.BOOLEAN,
          description: 'If true, automatically transition selected tasks to IN_PROGRESS in PlanManager (default: true).',
        },
        acquireFileLocks: {
          type: Type.BOOLEAN,
          description: 'If true, automatically acquire file locks for files in each task writeSet (default: true).',
        },
      },
    },
    async execute(args: Record<string, any>, _workspace: Workspace): Promise<Record<string, any>> {
      const action = String(args.action || 'next_batch').trim().toLowerCase();
      const planManager = orchestrator.getPlanManager();
      if (!planManager) {
        return {
          success: false,
          error: 'NO_PLAN_MANAGER_BOUND: AgentOrchestrator is not bound to a PlanManager.',
        };
      }

      if (!planManager.hasPlan()) {
        return {
          success: false,
          error: 'NO_PLAN_EXISTS: PlanManager currently has no execution plan.',
        };
      }

      try {
        if (action === 'status') {
          const graph = planManager.getTaskGraph();
          const runnable = planManager.getRunnableParallelBatch({
            maxConcurrency: typeof args.maxConcurrency === 'number' ? args.maxConcurrency : 8,
            allowImplicitParallel: args.allowImplicitParallel !== false,
          });
          return {
            success: true,
            status: {
              allCompleted: planManager.isAllTasksCompleted(),
              progress: planManager.getProgress(),
              readyTaskIds: graph.readyTaskIds,
              runnableBatchTaskIds: runnable.map((t) => t.id),
              criticalPath: graph.criticalPath,
              parallelBatches: graph.parallelBatches,
              currentLocks: orchestrator.fileLockManager.getLocks(),
            },
          };
        }

        if (action === 'full_dag') {
          const summary = await orchestrator.executeFullDag({
            maxConcurrency: typeof args.maxConcurrency === 'number' ? args.maxConcurrency : 4,
            allowImplicitParallel: args.allowImplicitParallel !== false,
          });
          return {
            success: summary.isSuccess,
            summary: {
              totalTasks: summary.totalTasks,
              completedTasks: summary.completedTasks,
              failedTasks: summary.failedTasks,
              batchesExecuted: summary.batchesExecuted,
              executionTimeMs: summary.executionTimeMs,
              isSuccess: summary.isSuccess,
              results: Array.from(summary.taskResults.entries()).map(([id, res]) => ({
                taskId: id,
                ...res,
              })),
            },
          };
        }

        // Default: next_batch
        const batchResult = await orchestrator.scheduleNextDagBatch({
          maxConcurrency: typeof args.maxConcurrency === 'number' ? args.maxConcurrency : 4,
          allowImplicitParallel: args.allowImplicitParallel !== false,
          autoStartBatch: args.autoStartBatch !== false,
          acquireFileLocks: args.acquireFileLocks !== false,
          dispatchToSubagents: true,
        });

        return {
          success: true,
          batch: {
            batchNumber: batchResult.batchNumber,
            dispatchedTasks: batchResult.dispatchedTasks.map((d) => ({
              taskId: d.task.id,
              title: d.task.title,
              agentId: d.agentId,
              lockedFiles: d.lockedFiles,
              capabilities: d.capabilities,
            })),
            skippedOrDeferred: batchResult.skippedOrDeferred,
            remainingPendingCount: batchResult.remainingPendingCount,
            hasMoreRunnable: batchResult.hasMoreRunnable,
          },
        };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  };
}

