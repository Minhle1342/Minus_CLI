import type { Workspace } from '../workspace/workspace.js';
import type { CheckpointManager } from '../workspace/checkpoint.js';
import type { ContextCompactor } from './context-compactor.js';

export interface AgentLoopOptions {
  maxSteps?: number;
  workspace?: Workspace;
  checkpointManager?: CheckpointManager;
  contextCompactor?: ContextCompactor;
}

export type AgentState =
  | 'IDLE'
  | 'THINKING'
  | 'TOOL_REQUESTED'
  | 'TOOL_RUNNING'
  | 'TOOL_RESULT'
  | 'FINAL_ANSWER'
  | 'MAX_STEPS_REACHED';
