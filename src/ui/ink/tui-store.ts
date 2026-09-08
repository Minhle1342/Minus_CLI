import { EventEmitter } from 'node:events';
import { AgentKernel } from '../../kernel/kernel.js';
import { TuiState, TuiAction, TuiStepItem } from './types.js';

export function createInitialState(options: {
  modelName?: string;
  workspacePath?: string;
  sandboxMode?: string;
  maxContextTokens?: number;
}): TuiState {
  return {
    modelName: options.modelName || 'gemini-2.5-flash',
    workspacePath: options.workspacePath || process.cwd(),
    sandboxMode: options.sandboxMode || 'local',
    status: 'idle',
    activePhase: 'IDLE',
    currentStep: 0,
    maxSteps: 10,
    tokens: {
      used: 0,
      max: options.maxContextTokens || 1_000_000,
      promptTokens: 0,
      cachedTokens: 0,
      cacheHitRate: 0,
    },
    steps: [],
    liveReasoning: '',
    isReasoningCollapsed: true,
    isCompactMode: true,
    finalAnswer: null,
    errorMessage: null,
    activeDiff: null,
    activePermission: null,
  };
}

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case 'SET_MODEL':
      return { ...state, modelName: action.model };
    case 'SET_WORKSPACE':
      return { ...state, workspacePath: action.workspace };
    case 'SET_STATUS':
      return { ...state, status: action.status };
    case 'SET_PHASE':
      return { ...state, activePhase: action.phase };
    case 'STEP_START':
      return {
        ...state,
        currentStep: action.step,
        maxSteps: action.maxSteps,
        status: 'thinking',
        finalAnswer: null,
        errorMessage: null,
      };
    case 'STEP_END':
      return {
        ...state,
        status: 'idle',
      };
    case 'TOOL_START': {
      const newStepItem: TuiStepItem = {
        id: `step-${action.step}-${Date.now()}`,
        step: action.step,
        maxSteps: action.maxSteps,
        phase: action.phase,
        toolName: action.toolName,
        args: action.args,
        durationMs: 0,
        status: 'running',
        timestamp: Date.now(),
      };
      return {
        ...state,
        status: 'executing_tool',
        activePhase: action.phase,
        steps: [...state.steps.slice(-50), newStepItem],
      };
    }
    case 'TOOL_END': {
      const updatedSteps = [...state.steps];
      let lastIndex = -1;
      for (let i = updatedSteps.length - 1; i >= 0; i--) {
        if (updatedSteps[i].toolName === action.toolName && updatedSteps[i].status === 'running') {
          lastIndex = i;
          break;
        }
      }
      if (lastIndex !== -1) {
        const isError = action.result && (action.result.error || action.result.exitCode !== 0 && action.result.exitCode !== undefined);
        updatedSteps[lastIndex] = {
          ...updatedSteps[lastIndex],
          result: action.result,
          durationMs: action.durationMs,
          status: isError ? 'failed' : 'success',
          tokens: action.tokens,
        };
      }
      return {
        ...state,
        status: 'thinking',
        steps: updatedSteps,
      };
    }
    case 'REASONING_CHUNK':
      return {
        ...state,
        liveReasoning: state.liveReasoning + action.chunk,
      };
    case 'CLEAR_REASONING':
      return {
        ...state,
        liveReasoning: '',
      };
    case 'TOGGLE_REASONING_COLLAPSE':
      return {
        ...state,
        isReasoningCollapsed: !state.isReasoningCollapsed,
      };
    case 'TOGGLE_COMPACT_MODE':
      return {
        ...state,
        isCompactMode: !state.isCompactMode,
      };
    case 'USAGE_UPDATE': {
      const promptTok = action.usage.promptTokens || 0;
      const cachedTok = action.usage.cachedTokens || 0;
      const totalTok = action.usage.totalTokens || (promptTok + (action.usage.completionTokens || 0));
      const hitRate = promptTok + cachedTok > 0 ? (cachedTok / (promptTok + cachedTok)) * 100 : 0;
      return {
        ...state,
        tokens: {
          ...state.tokens,
          used: totalTok,
          promptTokens: promptTok,
          cachedTokens: cachedTok,
          cacheHitRate: Math.round(hitRate),
        },
      };
    }
    case 'FINAL_ANSWER':
      return {
        ...state,
        status: 'completed',
        finalAnswer: action.answer,
      };
    case 'ERROR':
      return {
        ...state,
        status: 'error',
        errorMessage: action.error,
      };
    case 'SHOW_DIFF':
      return {
        ...state,
        activeDiff: action.diff,
      };
    case 'CLEAR_DIFF':
      return {
        ...state,
        activeDiff: null,
      };
    case 'REQUEST_PERMISSION':
      return {
        ...state,
        activePermission: action.permission,
      };
    case 'RESOLVE_PERMISSION':
      return {
        ...state,
        activePermission: null,
      };
    default:
      return state;
  }
}

export class TuiStore extends EventEmitter {
  private state: TuiState;

  constructor(initialOptions: Parameters<typeof createInitialState>[0] = {}) {
    super();
    this.state = createInitialState(initialOptions);
  }

  getState(): TuiState {
    return this.state;
  }

  dispatch(action: TuiAction): void {
    this.state = tuiReducer(this.state, action);
    this.emit('change', this.state);
  }

  bindKernel(kernel: AgentKernel): () => void {
    const events = kernel.ctx.events;

    const onStepBefore = (step: number, maxSteps: number) => {
      this.dispatch({ type: 'STEP_START', step, maxSteps });
    };

    const onStepAfter = (step: number) => {
      this.dispatch({ type: 'STEP_END', step });
    };

    const onToolBefore = (toolName: string, args: Record<string, any>) => {
      this.dispatch({
        type: 'TOOL_START',
        toolName,
        args,
        step: this.state.currentStep,
        maxSteps: this.state.maxSteps,
        phase: this.state.activePhase,
      });
    };

    const onToolAfter = (toolName: string, result: Record<string, any>, durationMs: number) => {
      this.dispatch({ type: 'TOOL_END', toolName, result, durationMs });
    };

    const onModelThought = (thought: string) => {
      this.dispatch({ type: 'REASONING_CHUNK', chunk: thought });
    };

    const onModelUsage = (usage: any) => {
      this.dispatch({ type: 'USAGE_UPDATE', usage });
    };

    const onModelFinalAnswer = (answer: string) => {
      this.dispatch({ type: 'FINAL_ANSWER', answer });
    };

    const onWorkspaceChanged = (_: string, newPath: string) => {
      this.dispatch({ type: 'SET_WORKSPACE', workspace: newPath });
    };

    const onModelChanged = (newModel: string) => {
      this.dispatch({ type: 'SET_MODEL', model: newModel });
    };

    events.on('step:before', onStepBefore);
    events.on('step:after', onStepAfter);
    events.on('tool:before', onToolBefore);
    events.on('tool:after', onToolAfter);
    events.on('model:thought', onModelThought);
    events.on('model:usage', onModelUsage);
    events.on('model:final_answer', onModelFinalAnswer);
    events.on('workspace:changed', onWorkspaceChanged);
    events.on('model:changed', onModelChanged);

    return () => {
      events.off('step:before', onStepBefore);
      events.off('step:after', onStepAfter);
      events.off('tool:before', onToolBefore);
      events.off('tool:after', onToolAfter);
      events.off('model:thought', onModelThought);
      events.off('model:usage', onModelUsage);
      events.off('model:final_answer', onModelFinalAnswer);
      events.off('workspace:changed', onWorkspaceChanged);
      events.off('model:changed', onModelChanged);
    };
  }
}
