import React from 'react';
import { Box, Text } from 'ink';
import { AgentUIStatus, UIWorkflowPhase } from '../types.js';
import { inkColors } from '../../tui-theme.js';

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

  let statusColor: string | undefined = inkColors.muted;
  let statusLabel = 'Sẵn sàng';
  if (status === 'thinking') {
    statusColor = inkColors.accent;
    statusLabel = 'Đang suy nghĩ';
  } else if (status === 'executing_tool') {
    statusColor = inkColors.accent;
    statusLabel = 'Đang chạy';
  } else if (status === 'completed') {
    statusColor = inkColors.success;
    statusLabel = 'Hoàn tất';
  } else if (status === 'error') {
    statusColor = inkColors.danger;
    statusLabel = 'Lỗi';
  }

  return (
    <Box flexDirection="column" paddingX={1} marginY={0}>
      <Text wrap="truncate-end"><Text bold color={inkColors.accent}>MINUS</Text> · {modelName}</Text>
      <Text color={inkColors.muted} wrap="truncate-end">{shortWorkspace} · {safeSandbox}</Text>
      <Text color={statusColor}>{statusLabel}</Text>
    </Box>
  );
};
