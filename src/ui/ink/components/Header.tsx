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
  activePhase,
  currentStep,
  maxSteps,
}) => {
  const shortWorkspace = workspacePath.length > 30 ? `…${workspacePath.slice(-28)}` : workspacePath;

  let statusColor = 'gray';
  let statusLabel = 'IDLE';
  if (status === 'thinking') {
    statusColor = 'yellow';
    statusLabel = 'THINKING';
  } else if (status === 'executing_tool') {
    statusColor = 'cyan';
    statusLabel = 'EXECUTING';
  } else if (status === 'completed') {
    statusColor = 'green';
    statusLabel = 'COMPLETED';
  } else if (status === 'error') {
    statusColor = 'red';
    statusLabel = 'ERROR';
  }

  let phaseColor = 'gray';
  if (activePhase === 'EXPLORE') phaseColor = 'cyan';
  else if (activePhase === 'IMPLEMENT') phaseColor = 'yellow';
  else if (activePhase === 'VERIFY') phaseColor = 'green';
  else if (activePhase === 'RELEASE') phaseColor = 'magenta';

  const stepText = maxSteps > 0 && isFinite(maxSteps) ? `[${currentStep}/${maxSteps}]` : `[${currentStep}/∞]`;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={0}>
      <Box justifyContent="space-between">
        <Box gap={1}>
          <Text bold color="cyan">MINUS CODING AGENT</Text>
          <Text color="gray">│</Text>
          <Text color="magenta">🤖 {modelName}</Text>
          <Text color="gray">│</Text>
          <Text color="blue">🛡️  {sandboxMode.toUpperCase()}</Text>
        </Box>
        <Box gap={1}>
          <Text color="gray">📁 {shortWorkspace}</Text>
        </Box>
      </Box>
      <Box justifyContent="space-between" marginTop={0}>
        <Box gap={1}>
          <Text color={phaseColor} bold>[{activePhase}]</Text>
          <Text color="gray">{stepText}</Text>
        </Box>
        <Box gap={1}>
          <Text color="gray">Trạng thái:</Text>
          <Text color={statusColor} bold>{statusLabel}</Text>
        </Box>
      </Box>
    </Box>
  );
};
