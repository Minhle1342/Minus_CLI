import React from 'react';
import { Box, Text } from 'ink';

interface TelemetryBarProps {
  usedTokens: number;
  maxTokens: number;
  promptTokens: number;
  cachedTokens: number;
  cacheHitRate: number;
}

export const TelemetryBar: React.FC<TelemetryBarProps> = ({
  usedTokens,
  maxTokens,
  promptTokens,
  cachedTokens,
  cacheHitRate,
}) => {
  const percent = maxTokens > 0 ? Math.min(100, Math.round((usedTokens / maxTokens) * 100)) : 0;
  const barWidth = 20;
  const filled = Math.min(barWidth, Math.round((percent / 100) * barWidth));
  const empty = Math.max(0, barWidth - filled);

  let barColor = 'green';
  if (percent >= 80) barColor = 'red';
  else if (percent >= 50) barColor = 'yellow';

  const usedStr = usedTokens >= 1000 ? `${(usedTokens / 1000).toFixed(1)}k` : `${usedTokens}`;
  const maxStr = maxTokens >= 1000 ? `${(maxTokens / 1000).toFixed(0)}k` : `${maxTokens}`;

  return (
    <Box flexDirection="row" justifyContent="space-between" marginY={0} paddingX={1}>
      <Box gap={1}>
        <Text color="gray">Context:</Text>
        <Text color={barColor}>{'█'.repeat(filled)}</Text>
        <Text color="gray">{'░'.repeat(empty)}</Text>
        <Text color="cyan">{percent}%</Text>
        <Text color="gray">({usedStr} / {maxStr} tok)</Text>
      </Box>
      <Box gap={1}>
        <Text color="gray">Prompt Cache:</Text>
        <Text color={cacheHitRate > 0 ? 'green' : 'gray'} bold>
          {cacheHitRate}% {cacheHitRate > 0 ? '(warm)' : '(cold)'}
        </Text>
        {cachedTokens > 0 && (
          <Text color="gray">({cachedTokens >= 1000 ? `${(cachedTokens / 1000).toFixed(1)}k` : cachedTokens} tok)</Text>
        )}
      </Box>
    </Box>
  );
};
