import type { Workspace } from '../workspace/workspace.js';
import type { CheckpointManager } from '../workspace/checkpoint.js';
import type { ContextCompactor } from './context-compactor.js';
import type { ContextGuardian } from '../context/context-guardian.js';
import type { ContextAgent } from '../context/context-agent.js';
import type { SessionPersistence } from '../session/session-persistence.js';
import type { ToolScope } from '../tools/registry.js';
import type { AgentRegistry } from './agent-registry.js';
import type { ToolControlMode } from '../control/classification-types.js';
import type { StepPromptGatingMode } from './step-prompt-policy.js';
import type { ContextManagementMode } from './context-budget-manager.js';
import type { KernelEventBus } from '../kernel/kernel.js';
import type { TaskManager } from '../tasks/task-manager.js';

export interface AgentLoopOptions {
  /** TaskManager for background-command gating and the turn-end background wait. */
  taskManager?: TaskManager;
  /** Run in non-interactive / headless mode where permission denials gracefully continue instead of killing the turn. */
  headless?: boolean;
  nonInteractive?: boolean;
  maxSteps?: number;
  workspace?: Workspace;
  checkpointManager?: CheckpointManager;
  contextCompactor?: ContextCompactor;
  contextGuardian?: ContextGuardian;
  contextAgent?: ContextAgent;
  sessionPersistence?: SessionPersistence;
  toolScope?: ToolScope;
  agentId?: string;
  agentRegistry?: AgentRegistry;
  enableSubagents?: boolean;
  enableDynamicToolRetrieval?: boolean;
  enablePromptCaching?: boolean;
  /** Per-step prompt selection. off preserves legacy injection, shadow observes, enforce reduces context. */
  stepPromptGatingMode?: StepPromptGatingMode;
  enableStepSummarization?: boolean;
  /** Enable provider-neutral prompt-based soft latency coordination. */
  enableLatencyOptimization?: boolean;
  /** Soft target used only to steer the next model request; it never aborts an active request. */
  softStepTargetMs?: number;
  /** Fraction of usable model input budget that triggers proactive request compaction. */
  requestCompactionRatio?: number;
  /** Whole-request compaction rollout: legacy, shadow comparison, or hard-budget enforcement. */
  contextManagementMode?: ContextManagementMode;
  /** Finalize directly from a verified submit_solution summary instead of adding another model round trip. */
  enableSubmitAutoFinalization?: boolean;
  /** Run consecutive allow-listed read-only tools concurrently. */
  enableConcurrentReadTools?: boolean;
  /** Flush a read-only tool batch to session storage in one durable write. */
  enableBatchSessionPersistence?: boolean;
  /** Reuse repository map/memory context until a workspace mutation invalidates it. */
  enableDynamicContextCache?: boolean;
  /** Inject a task-personalized graph-ranked repository map into dynamic context. */
  enableGraphRepositoryMap?: boolean;
  /** Maximum estimated tokens reserved for the graph-ranked repository map. */
  repositoryMapTokens?: number;
  /** Disable citation-validated repository memory injection and observation capture. */
  enableRepositoryMemory?: boolean;
  /** Maximum estimated tokens reserved for validated repository memories. */
  repositoryMemoryTokens?: number;
  /** Per-turn classification and runtime tool authorization rollout mode. */
  toolControlMode?: ToolControlMode;
  /** Execute read-only tools speculatively during model token streaming. */
  enableStreamingDispatch?: boolean;
  /** Hard-terminate runtime when identical tool observations repeat consecutively (defaults to false). */
  enableNoProgressTermination?: boolean;
  /** Global Dynamic Budget for injected execution context in tokens (defaults to 2000). */
  dynamicContextBudget?: number;
  /** Custom prompt sections to seed the PromptAssembler (used by Subagents for progressive specialization). */
  promptSections?: any[];
  /**
   * Recreate an LLM client by model name (used to restore per-tab models after
   * restart, when only the name survived in the session log). Must never throw
   * interactive login flows — return undefined/null to fall back to default.
   */
  createSessionLLM?: (modelName: string) => Promise<any>;
  /**
   * Event bus dùng chung với parent: child loop không có kernel riêng nên không
   * phát event ra UI được. Truyền bus của parent để transcript subagent lên TUI
   * (mọi event của child được gắn cờ isSubagent).
   */
  eventBus?: KernelEventBus;
}

export type AgentState =
  | 'IDLE'
  | 'THINKING'
  | 'TOOL_REQUESTED'
  | 'TOOL_RUNNING'
  | 'TOOL_RESULT'
  | 'FINAL_ANSWER'
  | 'MAX_STEPS_REACHED';
