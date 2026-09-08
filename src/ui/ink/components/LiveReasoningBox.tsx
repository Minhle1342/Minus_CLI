import React from 'react';
import { Box, Text } from 'ink';

interface LiveReasoningBoxProps {
  reasoning: string;
  isCollapsed: boolean;
}

export const LiveReasoningBox: React.FC<LiveReasoningBoxProps> = ({ reasoning, isCollapsed }) => {
  if (!reasoning || reasoning.trim().length === 0) {
    return null;
  }

  const clean = reasoning.trim();
  const firstLine = clean.split('\n')[0] || '';
  const truncatedSummary = firstLine.length > 70 ? `${firstLine.slice(0, 67)}…` : firstLine;

  if (isCollapsed) {
    return (
      <Box paddingX={1} marginY={0} gap={1}>
        <Text color="yellow" bold>🧠 Thinking:</Text>
        <Text color="gray" italic>{truncatedSummary}</Text>
        <Text color="dim">(Ctrl+O để xem chi tiết)</Text>
      </Box>
    );
  }

  // Expanded mode: Show boxed thinking stream (bounded to 6 lines max)
  const lines = clean.split('\n').slice(-6);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1} marginY={0}>
      <Box justifyContent="space-between">
        <Text color="yellow" bold>🧠 REASONING TRACE (System 2 CoT)</Text>
        <Text color="gray">[Nhấn Ctrl+O để thu gọn]</Text>
      </Box>
      <Box flexDirection="column" marginTop={0}>
        {lines.map((line, idx) => (
          <Text key={idx} color="gray" italic>
            {line.length > 90 ? `${line.slice(0, 87)}…` : line}
          </Text>
        ))}
      </Box>
    </Box>
  );
};
