import type { Workspace } from '../workspace/workspace.js';
import type { CheckpointManager } from '../workspace/checkpoint.js';
import type { ContextCompactor } from './context-compactor.js';
import type { SessionPersistence } from '../session/session-persistence.js';
import type { ToolScope } from '../tools/registry.js';
import type { AgentRegistry } from './agent-registry.js';
import type { ToolControlMode } from '../control/classification-types.js';

export interface AgentLoopOptions {
  maxSteps?: number;
  workspace?: Workspace;
  checkpointManager?: CheckpointManager;
  contextCompactor?: ContextCompactor;
  sessionPersistence?: SessionPersistence;
  toolScope?: ToolScope;
  agentId?: string;
  agentRegistry?: AgentRegistry;
  enableSubagents?: boolean;
  enableDynamicToolRetrieval?: boolean;
  enablePromptCaching?: boolean;
  enableStepSummarization?: boolean;
  /** Enable provider-neutral prompt-based soft latency coordination. */
  enableLatencyOptimization?: boolean;
  /** Soft target used only to steer the next model request; it never aborts an active request. */
  softStepTargetMs?: number;
  /** Fraction of usable model input budget that triggers proactive request compaction. */
  requestCompactionRatio?: number;
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
  /** Enable streaming early pipelined dispatch of safe read-only tools. */
  enableStreamingDispatch?: boolean;
}

export type AgentState =
  | 'IDLE'
  | 'THINKING'
  | 'TOOL_REQUESTED'
  | 'TOOL_RUNNING'
  | 'TOOL_RESULT'
  | 'FINAL_ANSWER'
  | 'MAX_STEPS_REACHED';
