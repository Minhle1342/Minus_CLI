import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { TuiStore } from '../tui-store.js';
import { TuiState } from '../types.js';
import { Header } from './Header.js';
import { TelemetryBar } from './TelemetryBar.js';
import { StepStream } from './StepStream.js';
import { LiveReasoningBox } from './LiveReasoningBox.js';
import { DiffPreviewBox } from './DiffPreviewBox.js';
import { PermissionPromptBox } from './PermissionPromptBox.js';
import { InputPromptBar } from './InputPromptBar.js';

interface AppProps {
  store: TuiStore;
  onSubmitPrompt?: (prompt: string) => void;
  onAbort?: () => void;
}

export const App: React.FC<AppProps> = ({ store, onSubmitPrompt, onAbort }) => {
  const [state, setState] = useState<TuiState>(store.getState());

  useEffect(() => {
    const onStoreChange = (newState: TuiState) => {
      setState({ ...newState });
    };

    store.on('change', onStoreChange);
    return () => {
      store.off('change', onStoreChange);
    };
  }, [store]);

  const handleToggleCompact = () => {
    store.dispatch({ type: 'TOGGLE_REASONING_COLLAPSE' });
  };

  const handleSubmit = (value: string) => {
    if (onSubmitPrompt) {
      onSubmitPrompt(value);
    }
  };

  const handleAbort = () => {
    if (onAbort) {
      onAbort();
    } else {
      store.abortCurrent();
    }
  };

  const handleResolvePermission = (approved: boolean, rememberSession?: boolean) => {
    if (state.activePermission) {
      try {
        state.activePermission.resolve(approved, rememberSession);
      } catch {}
      store.dispatch({ type: 'RESOLVE_PERMISSION' });
    }
  };

  return (
    <Box flexDirection="column" width="100%">
      {/* 1. Header Banner */}
      <Header
        modelName={state.modelName}
        workspacePath={state.workspacePath}
        sandboxMode={state.sandboxMode}
        status={state.status}
        activePhase={state.activePhase}
        currentStep={state.currentStep}
        maxSteps={state.maxSteps}
      />

      {/* 2. Token Telemetry & Cache Bar */}
      <TelemetryBar
        usedTokens={state.tokens.used}
        maxTokens={state.tokens.max}
        promptTokens={state.tokens.promptTokens}
        cachedTokens={state.tokens.cachedTokens}
        cacheHitRate={state.tokens.cacheHitRate}
      />

      {/* 3. Live Reasoning Box (System 2 CoT) */}
      <LiveReasoningBox
        reasoning={state.liveReasoning}
        isCollapsed={state.isReasoningCollapsed}
        status={state.status}
        isThinking={state.isThinking}
        thinkingStartedAt={state.thinkingStartedAt}
      />

      {/* 4. Reactive Step Stream (One-Liner Log) */}
      <StepStream steps={state.steps} maxVisible={10} />

      {/* 5. Active Diff View (if inspecting a patch or mutation) */}
      {state.activeDiff && <DiffPreviewBox diff={state.activeDiff} />}

      {/* 6. Retry Information Banner (Exponential Backoff Feedback) */}
      {state.retryInfo && (
        <Box borderStyle="single" borderColor="red" paddingX={1} marginY={0}>
          <Text color="red" bold>
            🔄 [RETRYING] Đang thử lại (lần {state.retryInfo.attempt}/{state.retryInfo.maxRetries}) sau {(state.retryInfo.delayMs / 1000).toFixed(1)}s...
            {state.retryInfo.message ? ` (${state.retryInfo.message})` : ''}
          </Text>
        </Box>
      )}

      {/* 7. Aborting Indicator Banner */}
      {state.isAborting && (
        <Box borderStyle="single" borderColor="red" paddingX={1} marginY={0}>
          <Text color="red" bold>⏳ Đang dừng và hủy yêu cầu hiện tại...</Text>
        </Box>
      )}

      {/* 8. Final Answer Display */}
      {state.finalAnswer && (
        <Box flexDirection="column" borderStyle="single" borderColor="green" paddingX={1} marginY={0}>
          <Box justifyContent="space-between">
            <Text color="green" bold>✨ [HOÀN TẤT NHIỆM VỤ - FINAL ANSWER]</Text>
            <Text dimColor>RESULT</Text>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Text color="white" wrap="wrap">{state.finalAnswer}</Text>
          </Box>
        </Box>
      )}

      {/* 9. Error Banner */}
      {state.errorMessage && (
        <Box borderStyle="single" borderColor="red" paddingX={1} marginY={0}>
          <Text color="red" bold>✖ LỖI: {state.errorMessage}</Text>
        </Box>
      )}

      {/* 10. Active Permission Request Modal */}
      {state.activePermission && (
        <PermissionPromptBox
          permission={state.activePermission}
          onResolve={handleResolvePermission}
        />
      )}

      {/* 11. Input Prompt Bar (when idle or ready, disabled while tool/thinking/permission is active) */}
      <InputPromptBar
        onSubmit={handleSubmit}
        onToggleCompact={handleToggleCompact}
        onAbort={handleAbort}
        disabled={state.status === 'executing_tool' || state.status === 'thinking' || Boolean(state.activePermission)}
        workspacePath={state.workspacePath}
      />
    </Box>
  );
};
