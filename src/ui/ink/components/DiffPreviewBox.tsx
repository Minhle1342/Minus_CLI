import React from 'react';
import { Box, Text } from 'ink';
import { TuiDiffPayload } from '../types.js';
import { inkColors } from '../../tui-theme.js';

interface DiffPreviewBoxProps {
  diff: TuiDiffPayload;
}

export const DiffPreviewBox: React.FC<DiffPreviewBoxProps> = ({ diff }) => {
  const maxLines = 15;
  const lines = Array.isArray(diff?.lines) ? diff.lines : [];
  const renderLines = lines.slice(0, maxLines);
  const remainingCount = lines.length - maxLines;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={inkColors.muted} paddingX={1} marginY={0}>
      <Box justifyContent="space-between">
        <Text color={inkColors.accent} bold wrap="truncate-end">
          Diff · {diff?.file || 'unknown'}{diff?.isAutoApproved ? ' (tự động duyệt)' : ''}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={0}>
        {renderLines.map((line, idx) => {
          const text = (typeof line === 'string' ? line : String(line ?? '')).replace(/\t/g, '    ');
          let lineColor: string | undefined;
          if (text.startsWith('---') || text.startsWith('+++')) lineColor = inkColors.muted;
          else if (text.startsWith('@@')) lineColor = inkColors.accent;
          else if (text.startsWith('+')) lineColor = inkColors.success;
          else if (text.startsWith('-')) lineColor = inkColors.danger;

          return (
            <Text key={`diff-line-${idx}`} color={lineColor} wrap="wrap">
              {text}
            </Text>
          );
        })}
        {remainingCount > 0 && (
          <Text color={inkColors.muted}>
            … và {remainingCount} dòng nữa
          </Text>
        )}
      </Box>
    </Box>
  );
};
