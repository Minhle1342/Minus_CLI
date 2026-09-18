import React from 'react';
import { Box, Text, useInput } from 'ink';
import { TuiPermissionRequest } from '../types.js';
import { formatToolTargetWithLines } from './StepStream.js';

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
    <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1} marginY={0}>
      <Box justifyContent="space-between">
        <Text color="yellow" bold>
          ⚠️ YÊU CẦU PHÊ DUYỆT THỰC THI (PERMISSION REQUIRED)
        </Text>
        <Text color="gray">[Cần xác nhận]</Text>
      </Box>

      <Box gap={1} marginTop={0}>
        <Text color="white" bold>Công cụ:</Text>
        <Text color="yellow" bold>{permission.toolName}</Text>
        {target ? <Text color="gray">({String(target)})</Text> : null}
      </Box>

      <Box marginTop={0}>
        <Text color="white">
          Nhấn <Text color="green" bold>[y]</Text> Duyệt ·{' '}
          <Text color="cyan" bold>[a]</Text> Luôn duyệt trong phiên ·{' '}
          <Text color="red" bold>[n/Esc]</Text> Từ chối
        </Text>
      </Box>
    </Box>
  );
};
