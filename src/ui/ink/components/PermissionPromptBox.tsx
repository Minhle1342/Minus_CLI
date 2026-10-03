import React from 'react';
import { Box, Text, useInput } from 'ink';
import { TuiPermissionRequest } from '../types.js';
import { formatToolTargetWithLines } from './StepStream.js';
import { inkColors } from '../../tui-theme.js';

export interface PermissionPromptBoxProps {
  permission: TuiPermissionRequest;
  onResolve: (approved: boolean, rememberSession?: boolean) => void;
}

export const PermissionPromptBox: React.FC<PermissionPromptBoxProps> = ({
  permission,
  onResolve,
}) => {
  useInput((input, key) => {
    const char = (input || '').toLowerCase();
    if (char === 'y' || key.return) {
      onResolve(true, false);
    } else if (char === 'a') {
      onResolve(true, true);
    } else if (char === 'n' || key.escape || (key.ctrl && char === 'c')) {
      onResolve(false, false);
    }
  });

  const args = permission.args || {};
  const target = formatToolTargetWithLines(permission.toolName, args) || permission.target || '';

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={inkColors.warning} paddingX={1} marginY={0}>
      <Box justifyContent="space-between">
        <Text color={inkColors.warning} bold>
          Cần phê duyệt
        </Text>
      </Box>

      <Text wrap="truncate-end"><Text color={inkColors.muted}>Công cụ </Text><Text bold>{permission.toolName}</Text></Text>
      {target ? <Text color={inkColors.muted} wrap="truncate-end">{String(target)}</Text> : null}

      <Box marginTop={0}>
        <Text>
          <Text color={inkColors.success} bold>y</Text> duyệt ·{' '}
          <Text color={inkColors.accent} bold>a</Text> cả phiên ·{' '}
          <Text color={inkColors.danger} bold>n/Esc</Text> từ chối
        </Text>
      </Box>
    </Box>
  );
};
