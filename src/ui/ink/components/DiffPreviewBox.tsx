import React from 'react';
import { Box, Text } from 'ink';
import { TuiDiffPayload } from '../types.js';

interface DiffPreviewBoxProps {
  diff: TuiDiffPayload;
}

export const DiffPreviewBox: React.FC<DiffPreviewBoxProps> = ({ diff }) => {
  const maxLines = 15;
  const lines = Array.isArray(diff?.lines) ? diff.lines : [];
  const renderLines = lines.slice(0, maxLines);
  const remainingCount = lines.length - maxLines;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="red" paddingX={1} marginY={0}>
      <Box justifyContent="space-between">
        <Text color="red" bold>
          {diff?.isAutoApproved ? '⚡ [AUTO-APPROVED DIFF]' : '📝 [DIFF PREVIEW]'}: {diff?.file || 'unknown'}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={0}>
        {renderLines.map((line, idx) => {
          const text = typeof line === 'string' ? line : String(line ?? '');
          let lineColor = 'gray';
          if (text.startsWith('+')) lineColor = 'white';
          else if (text.startsWith('-')) lineColor = 'red';
          else if (text.startsWith('@@')) lineColor = 'red';
          else if (text.startsWith('---') || text.startsWith('+++')) lineColor = 'white';

          return (
            <Text key={`diff-line-${idx}`} color={lineColor}>
              {text.length > 95 ? `${text.slice(0, 92)}…` : text}
            </Text>
          );
        })}
        {remainingCount > 0 && (
          <Text color="gray" italic>
            ... (+{remainingCount} dòng thay đổi nữa)
          </Text>
        )}
      </Box>
    </Box>
  );
};
