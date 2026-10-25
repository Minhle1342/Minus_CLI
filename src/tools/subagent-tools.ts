import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { SubagentManager } from '../agent/subagent-manager.js';
import { AgentOrchestrator } from '../agent/agent-orchestrator.js';
import { MultiAgentBrainstormingEngine } from '../agent/multi-agent-brainstorming.js';
import { Workspace } from '../workspace/workspace.js';

import { AVAILABLE_MODELS } from '../ui/cli-ui.js';

export function createSpawnAgentTool(manager: SubagentManager, toolName = 'spawn_agent'): ToolDefinition {
  const isDelegate = toolName === 'delegate_agent';
  return {
    name: toolName,
    description: isDelegate
      ? 'PARALLEL SUBAGENT DELEGATION: Launch an asynchronous background subagent for an independent task. YOU CAN CALL THIS TOOL MULTIPLE TIMES IN PARALLEL within the same turn to run independent subtasks concurrently (e.g. parallel file exploration, concurrent test runs, multi-module analysis, or dividing work across benchmark specialists). Non-blocking; returns an agentId immediately without waiting, and the subagent proactively notifies you with its results upon completion.'
      : 'PARALLEL CLEAN-CONTEXT CHILD AGENT: Spawn an asynchronous background subagent with an explicit task brief and isolated context. YOU CAN CALL THIS TOOL MULTIPLE TIMES IN PARALLEL within a single turn to run independent subtasks concurrently (parallel code search, multi-file inspection, speculative exploration, or concurrent benchmark specialists). Non-blocking; returns an agentId immediately and sends a completion notification upon finish.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        brief: {
          type: Type.STRING,
          description: 'Task brief or objective for this subagent. When breaking down a goal into independent parts, emit multiple spawn_agent calls concurrently in parallel within the same turn, each with its own focused brief.',
        },
        objective: {
          type: Type.STRING,
          description: 'Alias for brief.',
        },
        model: {
          type: Type.STRING,
          description: 'Optional model override for this subagent (e.g. "internai/deepseek-v4-flash-0731", "internai/deepseek-v4-pro-0813", "internai/qwen3.8-27b", "gemini-2.5-flash"). If omitted, inherits parent model or specialistId default. Different parallel subagents can use different models tailored to their specific subtasks.',
        },
        specialistId: {
          type: Type.STRING,
          description: 'Optional benchmark specialist ID or alias (e.g. "subagent-deepseek-r1-math" for deep reasoning/math, "subagent-qwen25-coder-synthesis" for code synthesis, "subagent-gemini-swe-architect" for full-repo bugs, "subagent-llama33-instruction-governor" for strict instruction following, "subagent-codestral-fim-surgeon" for surgical infilling, "subagent-skeptical-adversary" for adversarial critique). Automatically configures the appropriate InternAI provider model and specialized prompt instructions.',
        },
        maxSteps: {
          type: Type.INTEGER,
          description: 'Subagent step limit (agent default).',
        },
        mode: {
          type: Type.STRING,
          description: 'Optional capability preset. Use "scout" for read-only exploration and inspection (no mutations, no command execution). RECOMMENDED FOR PARALLEL RECONNAISSANCE: scout subagents run safely in parallel without any file locking conflicts.',
        },
        toolNames: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Optional tool allowlist for this subagent.',
        },
        fileScope: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Scope of files allowed to change. To run multiple mutating subagents concurrently in parallel, assign disjoint (non-overlapping) file scopes to each subagent to prevent file locking conflicts.',
        },
        worktreePath: {
          type: Type.STRING,
          description: 'Optional isolated git worktree path for this subagent to operate in a completely isolated branch directory.',
        },
        verificationCommand: {
          type: Type.STRING,
          description: 'Test command to verify results when this subagent completes.',
        },
      },
    },
    async execute(args: Record<string, any>, _workspace: Workspace): Promise<Record<string, any>> {
      const task = String(args.brief || args.objective || '').trim();
      if (!task) return { error: 'Param "brief" or "objective" is required.' };
      const model = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : undefined;
      const specialistId = typeof args.specialistId === 'string' && args.specialistId.trim() ? args.specialistId.trim() : undefined;
      const handle = manager.start(task, {
        modelName: model,
        specialistId,
        maxSteps: typeof args.maxSteps === 'number' ? args.maxSteps : undefined,
        mode: args.mode === 'scout' ? 'scout' : undefined,
        toolNames: Array.isArray(args.toolNames) ? args.toolNames.map(String) : undefined,
        fileScope: Array.isArray(args.fileScope) ? args.fileScope.map(String) : undefined,
        worktreePath: args.worktreePath ? String(args.worktreePath) : undefined,
        verificationCommand: typeof args.verificationCommand === 'string' ? args.verificationCommand : undefined,
      });
      return { success: true, agentId: handle.id, agent: handle };
    },
  };
}

/** @deprecated Use spawn_agent. Kept as a 1-line alias for backwards compatibility. */
export function createDelegateAgentTool(manager: SubagentManager): ToolDefinition {
  return createSpawnAgentTool(manager, 'delegate_agent');
}

export function createMessageAgentTool(manager: SubagentManager): ToolDefinition {
  return {
    name: 'message_agent',
    description: 'Send a mid-flight instruction to a RUNNING background subagent. Queued as mid-turn steering: the subagent reads it at its NEXT step, without interrupting the current tool call. Track the effect via wait_agent/get_agent_result.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        agentId: {
          type: Type.STRING,
          description: 'Subagent id returned by delegate_agent / spawn_agent / allocate_agent_task.',
        },
        message: {
          type: Type.STRING,
          description: 'Instruction to inject at the subagent\'s next step (e.g. "skip section B", "scope down to X", "stop after the first file").',
        },
      },
      required: ['agentId', 'message'],
    },
    async execute(args: Record<string, any>, _workspace: Workspace): Promise<Record<string, any>> {
      const agentId = String(args.agentId || '').trim();
      const message = String(args.message || '').trim();
      if (!agentId) return { error: 'The "agentId" parameter is required.' };
      if (!message) return { error: 'The "message" parameter is required.' };
      const result = manager.sendMessage(agentId, `[MESSAGE FROM PARENT AGENT (mid-turn steering)]:\n${message}`);
      if (!result.sent) return { error: result.reason };
      return {
        success: true,
        agentId,
        delivered: 'queued-for-next-step',
        note: 'The subagent reads this at its next step; use wait_agent or get_agent_result to await its outcome.',
      };
    },
  };
}

export function createDelegateTaskTool(manager: SubagentManager): ToolDefinition {
  return {
    name: 'delegate_task',
    description: 'SYNCHRONOUS SUBTASK DELEGATION (BLOCKING): Delegate a single bounded subtask to an isolated subagent and wait synchronously for its summary. IMPORTANT: If you have 2 or more independent subtasks, PREFER USING "spawn_agent" MULTIPLE TIMES IN PARALLEL instead of sequentially blocking on delegate_task!',
    parameters: {
      type: Type.OBJECT,
      properties: {
        task: {
          type: Type.STRING,
          description: 'Clear description of the single subtask to perform synchronously.',
        },
        model: {
          type: Type.STRING,
          description: 'Optional model override for the subagent (e.g. "internai/deepseek-v4-flash-0731", "internai/deepseek-v4-pro-0813", "internai/qwen3.8-27b", "gemini-2.5-flash"). If omitted, inherits parent model or specialist default.',
        },
        specialistId: {
          type: Type.STRING,
          description: 'Optional benchmark specialist ID or alias (e.g. "subagent-deepseek-r1-math", "subagent-internai-qwen38-coder", "subagent-gemini-swe-architect") to inherit model and system instructions.',
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
        mode: {
          type: Type.STRING,
          description: 'Optional capability preset. Use "scout" for a read-only exploration agent (no file mutations, no commands).',
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
      const model = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : undefined;
      const specialistId = typeof args.specialistId === 'string' && args.specialistId.trim() ? args.specialistId.trim() : undefined;
      const allowedTools = Array.isArray(args.allowedTools) ? args.allowedTools.map(String) : undefined;
      const verificationCommand = typeof args.verificationCommand === 'string' ? args.verificationCommand : undefined;

      const result = await manager.executeIsolatedTask(task, {
        maxSteps,
        modelName: model,
        specialistId,
        allowedTools,
        mode: args.mode === 'scout' ? 'scout' : undefined,
        verificationCommand,
        signal: context?.signal,
      });

      return result;
    },
  };
}


export function createModelsTool(): ToolDefinition {
  return {
    name: 'models',
    description: 'List available models and providers (OpenCode v2.0.5 parity). Use to inspect available models when selecting a fast/flash model for subagents or session switching.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'Optional search filter to match model ID, name, or provider (e.g. "flash", "deepseek", "gemini", "groq").',
        },
        limit: {
          type: Type.INTEGER,
          description: 'Maximum number of models to return (default: 20).',
        },
      },
    },
    async execute(args: Record<string, any>): Promise<Record<string, any>> {
      const q = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
      const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 20;

      let list = AVAILABLE_MODELS;
      if (q) {
        list = list.filter((m) =>
          m.name.toLowerCase().includes(q)
          || m.id.toLowerCase().includes(q)
          || m.provider.toLowerCase().includes(q)
          || (m.desc && m.desc.toLowerCase().includes(q)),
        );
      }

      return {
        success: true,
        total: list.length,
        models: list.slice(0, limit).map((m) => ({
          id: m.id,
          name: m.name,
          provider: m.provider,
          description: m.desc,
          recommended: m.recommended ?? false,
        })),
      };
    },
  };
}

export function createWaitAgentTool(manager: SubagentManager): ToolDefinition {
  return {
    name: 'wait_agent',
    description: 'Wait for a background subagent (or one of several parallel subagents) to finish with a safe event-driven timeout (no resource-wasting polling). Useful after launching parallel subagents with spawn_agent when you need an agent\'s result before proceeding.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        agentId: {
          type: Type.STRING,
          description: 'ID of the subagent to wait for (returned by spawn_agent / delegate_agent / allocate_agent_task).',
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
          result: handle.resultBundle,
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
    description: 'Non-blocking status inspection: Check the current execution state, answer, touched files, and structured artifacts of a running or completed subagent. Useful to check progress across multiple parallel subagents without waiting.',
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
      return agent
        ? { success: true, agent, answer: agent.answer, result: agent.resultBundle }
        : { success: false, error: 'SUBAGENT_NOT_FOUND', agentId };
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
    description: 'PARALLEL SPECIALIST ALLOCATION: Assign and coordinate an independent task to a specialist agent based on capability matching (e.g. ["math"], ["coding"], ["swe-bench"], ["governance"], ["fim"], ["critic"]). You can call this tool multiple times in parallel to dispatch independent workloads to different specialists with automatic anti-duplication and safe file locking.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        objective: {
          type: Type.STRING,
          description: 'Independent objective to perform. To run parallel workflows, invoke allocate_agent_task multiple times concurrently for each independent objective.',
        },
        requiredCapabilities: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'List of required specialist capabilities (e.g. ["math"], ["coding", "synthesis"], ["swe-bench", "architecture"], ["governance"], ["fim"], ["critic"]).',
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
          description: 'Scope of files allowed to change. Assign non-overlapping file scopes to run multiple mutating subagents concurrently without file lock conflicts.',
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
    description: 'PARALLEL DAG BATCH EXECUTION: Schedule and trigger parallel multi-agent execution via a Directed Acyclic Graph (DAG) for PlanManager tasks. Automatically identifies parallelizable tasks without Read/Write set conflicts and dispatches them simultaneously to concurrent subagents. Supports "next_batch" (dispatch current runnable batch in parallel), "full_dag" (run entire plan to completion in parallel batches), or "status" (check DAG readiness and file locks).',
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

