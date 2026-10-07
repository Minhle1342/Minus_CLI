import React, { useState, useEffect } from 'react';
import { Box, Text, useWindowSize } from 'ink';
import { TuiStore } from '../tui-store.js';
import { TuiState } from '../types.js';
import { Header } from './Header.js';
import { TelemetryBar } from './TelemetryBar.js';
import { StepStream } from './StepStream.js';
import { LiveReasoningBox } from './LiveReasoningBox.js';
import { DiffPreviewBox } from './DiffPreviewBox.js';
import { PermissionPromptBox } from './PermissionPromptBox.js';
import { InputPromptBar } from './InputPromptBar.js';
import { CLI } from '../../cli-ui.js';
import { inkColors } from '../../tui-theme.js';
import { compactionStatus, formatCompactionStatus } from '../../compaction-status.js';

interface AppProps {
  store: TuiStore;
  onSubmitPrompt?: (prompt: string) => void;
  onAbort?: () => void;
}

export const App: React.FC<AppProps> = ({ store, onSubmitPrompt, onAbort }) => {
  const [state, setState] = useState<TuiState>(store.getState());
  const [compaction, setCompaction] = useState(compactionStatus.get());
  useEffect(() => compactionStatus.subscribe(setCompaction), []);
  const { columns } = useWindowSize();
  // The final-answer box has two border cells and two horizontal padding cells.
  const answerWidth = Math.max(1, (columns || 80) - 4);

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
    if (store.getState().isAborting) return;
    store.abortCurrent();
    onAbort?.();
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

      {/* 3. Live Reasoning Box (System 2 CoT & LLM Reconnecting State) */}
      <LiveReasoningBox
        reasoning={state.liveReasoning}
        isCollapsed={state.isReasoningCollapsed}
        status={state.status}
        isThinking={state.isThinking}
        thinkingStartedAt={state.thinkingStartedAt}
        isAborting={state.isAborting}
        reasoningInterrupted={state.reasoningInterrupted}
        retryInfo={state.retryInfo}
      />

      {/* 4. Reactive Step Stream (One-Liner Log) */}
      <StepStream steps={state.steps} maxVisible={10} />
      {compaction && (
        <Box height={1} flexShrink={0}>
          <Text wrap="truncate-end" color={compaction.state === 'failed' ? inkColors.danger : compaction.state === 'completed' ? 'green' : 'yellow'}>
            {formatCompactionStatus(compaction)}
          </Text>
        </Box>
      )}

      {/* 5. Active Diff View (if inspecting a patch or mutation) */}
      {state.activeDiff && <DiffPreviewBox diff={state.activeDiff} />}

      {/* 7. Aborting Indicator Banner */}
      {state.isAborting && (
        <Box borderStyle="single" borderColor="red" paddingX={1} marginY={0}>
          <Text color="red" bold>⏳ Stopping the current request...</Text>
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
            <Text color="white" wrap="wrap">{CLI.formatMarkdownTables(state.finalAnswer, { width: answerWidth, layout: 'stacked' })}</Text>
          </Box>
        </Box>
      )}

      {/* 9. Error Banner */}
      {state.errorMessage && (
        <Box paddingX={1} marginY={0}>
          <Text color={inkColors.danger} bold>Lỗi: {state.errorMessage}</Text>
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
        disabled={state.isAborting || state.status === 'executing_tool' || state.status === 'thinking' || Boolean(state.activePermission)}
        workspacePath={state.workspacePath}
      />
    </Box>
  );
};
