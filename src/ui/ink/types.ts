import { LLMUsage } from '../../llm/gemini.js';

export type AgentUIStatus = 'idle' | 'thinking' | 'executing_tool' | 'completed' | 'error';
export type UIWorkflowPhase = 'EXPLORE' | 'IMPLEMENT' | 'VERIFY' | 'RELEASE' | 'IDLE';

export interface TuiStepItem {
  id: string;
  step: number;
  maxSteps: number;
  phase: UIWorkflowPhase;
  toolName: string;
  args: Record<string, any>;
  durationMs: number;
  result?: Record<string, any>;
  status: 'running' | 'success' | 'failed';
  tokens?: number;
  timestamp: number;
}

export interface TuiDiffPayload {
  file: string;
  lines: string[];
  isAutoApproved?: boolean;
}

export interface TuiPermissionRequest {
  id: string;
  toolName: string;
  target?: string;
  args: Record<string, any>;
  diff?: TuiDiffPayload;
  resolve: (approved: boolean, rememberSession?: boolean) => void;
}

export interface TuiState {
  modelName: string;
  workspacePath: string;
  sandboxMode: string;
  status: AgentUIStatus;
  activePhase: UIWorkflowPhase;
  currentStep: number;
  maxSteps: number;
  tokens: {
    used: number;
    max: number;
    promptTokens: number;
    cachedTokens: number;
    cacheHitRate: number;
  };
  steps: TuiStepItem[];
  liveReasoning: string;
  isThinking: boolean;
  thinkingStartedAt: number | null;
  isReasoningCollapsed: boolean;
  isCompactMode: boolean;
  finalAnswer: string | null;
  errorMessage: string | null;
  activeDiff: TuiDiffPayload | null;
  activePermission: TuiPermissionRequest | null;
}

export type TuiAction =
  | { type: 'SET_MODEL'; model: string }
  | { type: 'SET_WORKSPACE'; workspace: string }
  | { type: 'SET_STATUS'; status: AgentUIStatus }
  | { type: 'SET_PHASE'; phase: UIWorkflowPhase }
  | { type: 'STEP_START'; step: number; maxSteps: number }
  | { type: 'STEP_END'; step: number }
  | { type: 'TOOL_START'; toolName: string; args: Record<string, any>; step: number; maxSteps: number; phase: UIWorkflowPhase }
  | { type: 'TOOL_END'; toolName: string; result: Record<string, any>; durationMs: number; tokens?: number }
  | { type: 'THINKING_START'; startedAt: number }
  | { type: 'THINKING_END' }
  | { type: 'REASONING_CHUNK'; chunk: string }
  | { type: 'CLEAR_REASONING' }
  | { type: 'TOGGLE_REASONING_COLLAPSE' }
  | { type: 'TOGGLE_COMPACT_MODE' }
  | { type: 'USAGE_UPDATE'; usage: LLMUsage }
  | { type: 'FINAL_ANSWER'; answer: string }
  | { type: 'ERROR'; error: string }
  | { type: 'SHOW_DIFF'; diff: TuiDiffPayload }
  | { type: 'CLEAR_DIFF' }
  | { type: 'REQUEST_PERMISSION'; permission: TuiPermissionRequest }
  | { type: 'RESOLVE_PERMISSION' };
