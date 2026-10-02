import React from 'react';
import { Box, Text } from 'ink';
import type { AgentUIStatus } from '../types.js';
import { LoadingSpinner } from './StepStream.js';

interface LiveReasoningBoxProps {
  reasoning: string;
  isCollapsed: boolean;
  status: AgentUIStatus;
  isThinking: boolean;
  thinkingStartedAt?: number | null;
  isAborting?: boolean;
  reasoningInterrupted?: boolean;
}

export const LiveReasoningBox: React.FC<LiveReasoningBoxProps> = ({
  reasoning,
  isCollapsed,
  status,
  isThinking,
  thinkingStartedAt,
  isAborting = false,
  reasoningInterrupted = false,
}) => {
  const hasReasoning = Boolean(reasoning && reasoning.trim().length > 0);

  if (!hasReasoning && !(isThinking && status === 'thinking') && !reasoningInterrupted) {
    return null;
  }

  if (!hasReasoning) {
    return (
      <Box paddingX={1} marginY={0} gap={1}>
        <Text color="red" bold>🧠 Thinking:</Text>
        {reasoningInterrupted
          ? <Text color="yellow">{isAborting ? 'Stopping…' : 'Thinking interrupted'}</Text>
          : <LoadingSpinner startTime={thinkingStartedAt ?? undefined} />}
      </Box>
    );
  }

  const clean = reasoning.trim();
  const firstLine = clean.split('\n')[0] || '';
  const truncatedSummary = firstLine.length > 70 ? `${firstLine.slice(0, 67)}…` : firstLine;

  if (isCollapsed) {
    return (
      <Box paddingX={1} marginY={0} gap={1}>
        <Text color="red" bold>🧠 Thinking:</Text>
        <Text color="white" italic>{truncatedSummary}</Text>
        {reasoningInterrupted && <Text color="yellow">{isAborting ? '(Stopping…)' : '(Thinking interrupted)'}</Text>}
        <Text color="gray" dimColor>(Ctrl+O to expand)</Text>
      </Box>
    );
  }

  // Expanded mode: Show boxed thinking stream (bounded to 6 lines max)
  const lines = clean.split('\n').slice(-6);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="red" paddingX={1} marginY={0}>
      <Box justifyContent="space-between">
        <Text color="red" bold>🧠 REASONING TRACE (System 2 CoT)</Text>
        <Text color="gray">[Ctrl+O to collapse]</Text>
      </Box>
      {reasoningInterrupted && <Text color="yellow">{isAborting ? 'Stopping…' : 'Thinking interrupted'}</Text>}
      <Box flexDirection="column" marginTop={0}>
        {lines.map((line, idx) => (
          <Text key={idx} color="white" italic>
            {line.length > 90 ? `${line.slice(0, 87)}…` : line}
          </Text>
        ))}
      </Box>
    </Box>
  );
};
