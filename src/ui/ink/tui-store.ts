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
    isThinking: false,
    thinkingStartedAt: null,
    isReasoningCollapsed: true,
    isCompactMode: true,
    finalAnswer: null,
    errorMessage: null,
    activeDiff: null,
    activePermission: null,
    isAborting: false,
    retryInfo: null,
  };
}

export class StreamBatcher {
  private buffer: string = '';
  private timer: NodeJS.Timeout | null = null;
  private readonly flushIntervalMs: number = 33; // ~30 FPS frame coalescing

  constructor(private onFlush: (batchedChunk: string) => void) {}

  public push(token: string): void {
    this.buffer += token;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.flush();
      }, this.flushIntervalMs);
      this.timer.unref?.();
    }
  }

  public flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length > 0) {
      const chunk = this.buffer;
      this.buffer = '';
      try {
        this.onFlush(chunk);
      } catch {}
    }
  }

  public clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buffer = '';
  }
}

let stepSequenceCounter = 0;

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
        isThinking: false,
        thinkingStartedAt: null,
        liveReasoning: '',
        finalAnswer: null,
        errorMessage: null,
        isAborting: false,
        retryInfo: null,
      };
    case 'STEP_END':
      return {
        ...state,
        status: 'idle',
        isAborting: false,
        retryInfo: null,
      };
    case 'TOOL_START': {
      const newStepItem: TuiStepItem = {
        id: `step-${action.step}-${Date.now()}-${++stepSequenceCounter}`,
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
        isThinking: false,
        thinkingStartedAt: null,
        activePhase: action.phase,
        steps: [...state.steps.slice(-25), newStepItem],
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
      const hasRunningTools = updatedSteps.some((s) => s.status === 'running');
      return {
        ...state,
        status: hasRunningTools ? 'executing_tool' : 'thinking',
        isThinking: !hasRunningTools,
        thinkingStartedAt: hasRunningTools ? state.thinkingStartedAt : null,
        steps: updatedSteps,
      };
    }
    case 'THINKING_START':
      return {
        ...state,
        status: 'thinking',
        isThinking: true,
        thinkingStartedAt: action.startedAt,
        liveReasoning: '',
        finalAnswer: null,
        errorMessage: null,
      };
    case 'THINKING_END':
      return {
        ...state,
        isThinking: false,
        thinkingStartedAt: null,
      };
    case 'REASONING_CHUNK': {
      const combined = state.liveReasoning + action.chunk;
      // Bounded Circular Ring Buffer: Giữ tối đa 4.000 ký tự gần nhất hiển thị trên TUI để tránh rò rỉ RAM Heap
      const boundedReasoning = combined.length > 4000 ? combined.slice(-3500) : combined;
      return {
        ...state,
        liveReasoning: boundedReasoning,
      };
    }
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
        isThinking: false,
        thinkingStartedAt: null,
        finalAnswer: action.answer,
      };
    case 'ERROR':
      return {
        ...state,
        status: 'error',
        isThinking: false,
        thinkingStartedAt: null,
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
    case 'SET_ABORTING':
      return {
        ...state,
        isAborting: action.isAborting,
      };
    case 'RETRY_UPDATE':
      return {
        ...state,
        retryInfo: action.retryInfo,
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

  abortCurrent(): void {
    this.dispatch({ type: 'SET_ABORTING', isAborting: true });
    this.emit('abort');
  }

  bindKernel(kernel: AgentKernel): () => void {
    const events = kernel.ctx.events;

    // Stream Batcher (Frame Coalescing ~30 FPS) giúp triệt tiêu bão re-render và chống tràn RAM Heap
    const batcher = new StreamBatcher((batchedThought) => {
      this.dispatch({ type: 'REASONING_CHUNK', chunk: batchedThought });
    });

    const onStepBefore = (step: number, maxSteps: number) => {
      batcher.flush();
      this.dispatch({ type: 'STEP_START', step, maxSteps });
    };

    const onStepAfter = (step: number) => {
      batcher.flush();
      this.dispatch({ type: 'STEP_END', step });
    };

    const onToolBefore = (toolName: string, args: Record<string, any>) => {
      batcher.flush();
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
      batcher.flush();
      this.dispatch({ type: 'TOOL_END', toolName, result, durationMs });
    };

    const onThinkingStart = (lifecycle: { startedAt: number }) => {
      batcher.clear();
      this.dispatch({ type: 'THINKING_START', startedAt: lifecycle.startedAt });
    };

    const onThinkingEnd = () => {
      batcher.flush();
      this.dispatch({ type: 'THINKING_END' });
    };

    const onModelThought = (thought: string) => {
      batcher.push(thought);
    };

    const onModelUsage = (usage: any) => {
      this.dispatch({ type: 'USAGE_UPDATE', usage });
    };

    const onModelFinalAnswer = (answer: string) => {
      batcher.flush();
      this.dispatch({ type: 'FINAL_ANSWER', answer });
    };

    const onWorkspaceChanged = (_: string, newPath: string) => {
      this.dispatch({ type: 'SET_WORKSPACE', workspace: newPath });
    };

    const onModelChanged = (newModel: string) => {
      this.dispatch({ type: 'SET_MODEL', model: newModel });
    };

    const onModelRetry = (retryPayload: { attempt: number; maxRetries: number; delayMs: number; message?: string } | null) => {
      this.dispatch({ type: 'RETRY_UPDATE', retryInfo: retryPayload });
    };

    const onAbortRequested = () => {
      batcher.clear();
      // Forward abort signal to kernel and event bus
      try {
        events.emit('agent:abort');
        events.emit('abort');
      } catch {}
      if (typeof (kernel as any).cancelCurrentTask === 'function') {
        (kernel as any).cancelCurrentTask();
      }
      if (typeof (kernel as any).abort === 'function') {
        (kernel as any).abort();
      }
    };

    this.on('abort', onAbortRequested);

    events.on('step:before', onStepBefore);
    events.on('step:after', onStepAfter);
    events.on('tool:before', onToolBefore);
    events.on('tool:after', onToolAfter);
    events.on('model:thinking:start', onThinkingStart);
    events.on('model:thinking:end', onThinkingEnd);
    events.on('model:thought', onModelThought);
    events.on('model:usage', onModelUsage);
    events.on('model:final_answer', onModelFinalAnswer);
    events.on('workspace:changed', onWorkspaceChanged);
    events.on('model:changed', onModelChanged);
    (events as any).on?.('model:retry', onModelRetry);

    return () => {
      batcher.clear();
      this.off('abort', onAbortRequested);
      events.off('step:before', onStepBefore);
      events.off('step:after', onStepAfter);
      events.off('tool:before', onToolBefore);
      events.off('tool:after', onToolAfter);
      events.off('model:thinking:start', onThinkingStart);
      events.off('model:thinking:end', onThinkingEnd);
      events.off('model:thought', onModelThought);
      events.off('model:usage', onModelUsage);
      events.off('model:final_answer', onModelFinalAnswer);
      events.off('workspace:changed', onWorkspaceChanged);
      events.off('model:changed', onModelChanged);
      (events as any).off?.('model:retry', onModelRetry);
    };
  }
}
