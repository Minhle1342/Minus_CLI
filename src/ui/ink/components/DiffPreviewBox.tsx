import React from 'react';
import { Box, Text } from 'ink';
import { TuiDiffPayload } from '../types.js';

interface DiffPreviewBoxProps {
  diff: TuiDiffPayload;
}

export const DiffPreviewBox: React.FC<DiffPreviewBoxProps> = ({ diff }) => {
  const maxLines = 15;
  const renderLines = diff.lines.slice(0, maxLines);
  const remainingCount = diff.lines.length - maxLines;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1} marginY={0}>
      <Box justifyContent="space-between">
        <Text color="cyan" bold>
          {diff.isAutoApproved ? '⚡ [AUTO-APPROVED DIFF]' : '📝 [DIFF PREVIEW]'}: {diff.file}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={0}>
        {renderLines.map((line, idx) => {
          let lineColor = 'gray';
          if (line.startsWith('+')) lineColor = 'green';
          else if (line.startsWith('-')) lineColor = 'red';
          else if (line.startsWith('@@')) lineColor = 'cyan';
          else if (line.startsWith('---') || line.startsWith('+++')) lineColor = 'white';

          return (
            <Text key={idx} color={lineColor}>
              {line.length > 95 ? `${line.slice(0, 92)}…` : line}
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
