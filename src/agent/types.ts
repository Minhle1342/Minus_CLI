import type { Workspace } from '../workspace/workspace.js';
import type { CheckpointManager } from '../workspace/checkpoint.js';
import type { ContextCompactor } from './context-compactor.js';
import type { SessionPersistence } from '../session/session-persistence.js';
import type { ToolScope } from '../tools/registry.js';
import type { AgentRegistry } from './agent-registry.js';

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
  /** Inject a task-personalized graph-ranked repository map into dynamic context. */
  enableGraphRepositoryMap?: boolean;
  /** Maximum estimated tokens reserved for the graph-ranked repository map. */
  repositoryMapTokens?: number;
  /** Disable citation-validated repository memory injection and observation capture. */
  enableRepositoryMemory?: boolean;
  /** Maximum estimated tokens reserved for validated repository memories. */
  repositoryMemoryTokens?: number;
}

export type AgentState =
  | 'IDLE'
  | 'THINKING'
  | 'TOOL_REQUESTED'
  | 'TOOL_RUNNING'
  | 'TOOL_RESULT'
  | 'FINAL_ANSWER'
  | 'MAX_STEPS_REACHED';
