import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { TuiStore } from '../tui-store.js';
import { TuiState } from '../types.js';
import { Header } from './Header.js';
import { TelemetryBar } from './TelemetryBar.js';
import { StepStream } from './StepStream.js';
import { LiveReasoningBox } from './LiveReasoningBox.js';
import { DiffPreviewBox } from './DiffPreviewBox.js';
import { InputPromptBar } from './InputPromptBar.js';

interface AppProps {
  store: TuiStore;
  onSubmitPrompt?: (prompt: string) => void;
}

export const App: React.FC<AppProps> = ({ store, onSubmitPrompt }) => {
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
      />

      {/* 4. Reactive Step Stream (One-Liner Log) */}
      <StepStream steps={state.steps} maxVisible={10} />

      {/* 5. Active Diff View (if inspecting a patch or mutation) */}
      {state.activeDiff && <DiffPreviewBox diff={state.activeDiff} />}

      {/* 6. Final Answer Display */}
      {state.finalAnswer && (
        <Box flexDirection="column" borderStyle="single" borderColor="green" paddingX={1} marginY={0}>
          <Text color="green" bold>✨ [HOÀN TẤT NHIỆM VỤ]</Text>
          <Text color="white">{state.finalAnswer}</Text>
        </Box>
      )}

      {/* 7. Error Banner */}
      {state.errorMessage && (
        <Box borderStyle="single" borderColor="red" paddingX={1} marginY={0}>
          <Text color="red" bold>✖ LỖI: {state.errorMessage}</Text>
        </Box>
      )}

      {/* 8. Input Prompt Bar (when idle or ready) */}
      <InputPromptBar
        onSubmit={handleSubmit}
        onToggleCompact={handleToggleCompact}
        disabled={state.status === 'executing_tool' || state.status === 'thinking'}
        workspacePath={state.workspacePath}
      />
    </Box>
  );
};
