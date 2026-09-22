import React from 'react';
import { Box, Text } from 'ink';
import { AgentUIStatus, UIWorkflowPhase } from '../types.js';

interface HeaderProps {
  modelName: string;
  workspacePath: string;
  sandboxMode: string;
  status: AgentUIStatus;
  activePhase: UIWorkflowPhase;
  currentStep: number;
  maxSteps: number;
}

export const Header: React.FC<HeaderProps> = ({
  modelName,
  workspacePath,
  sandboxMode,
  status,
}) => {
  const safeWorkspace = workspacePath || '';
  const shortWorkspace = safeWorkspace.length > 30 ? `…${safeWorkspace.slice(-28)}` : safeWorkspace;
  const safeSandbox = (sandboxMode || 'local').toUpperCase();

  let statusColor = 'gray';
  let statusLabel = 'IDLE';
  if (status === 'thinking') {
    statusColor = 'red';
    statusLabel = 'THINKING';
  } else if (status === 'executing_tool') {
    statusColor = 'white';
    statusLabel = 'EXECUTING';
  } else if (status === 'completed') {
    statusColor = 'white';
    statusLabel = 'COMPLETED';
  } else if (status === 'error') {
    statusColor = 'red';
    statusLabel = 'ERROR';
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1} marginY={0}>
      <Box justifyContent="space-between">
        <Box gap={1}>
          <Text bold color="red">MINUS CODING AGENT</Text>
          <Text color="gray">│</Text>
          <Text color="white">🤖 {modelName}</Text>
          <Text color="gray">│</Text>
          <Text color="white">🛡️  {safeSandbox}</Text>
        </Box>
        <Box gap={1}>
          <Text color="gray">📁 {shortWorkspace}</Text>
        </Box>
      </Box>
      <Box justifyContent="flex-end" marginTop={0}>
        <Box gap={1}>
          <Text color="gray">Trạng thái:</Text>
          <Text color={statusColor} bold>{statusLabel}</Text>
        </Box>
      </Box>
    </Box>
  );
};
