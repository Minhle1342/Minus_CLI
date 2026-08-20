import type { Workspace } from '../workspace/workspace.js';

export interface AgentLoopOptions {
  maxSteps?: number;
  workspace?: Workspace;
}

export type AgentState =
  | 'IDLE'
  | 'THINKING'
  | 'TOOL_REQUESTED'
  | 'TOOL_RUNNING'
  | 'TOOL_RESULT'
  | 'FINAL_ANSWER'
  | 'MAX_STEPS_REACHED';
