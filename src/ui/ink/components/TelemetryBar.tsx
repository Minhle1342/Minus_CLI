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
  usedTokens = 0,
  maxTokens = 1_000_000,
  promptTokens = 0,
  cachedTokens = 0,
  cacheHitRate = 0,
}) => {
  const validUsed = Number.isFinite(usedTokens) ? Math.max(0, usedTokens) : 0;
  const validMax = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 1;
  const percent = Math.min(100, Math.max(0, Math.round((validUsed / validMax) * 100)));
  const barWidth = 20;
  const filled = Number.isFinite(percent) ? Math.min(barWidth, Math.max(0, Math.round((percent / 100) * barWidth))) : 0;
  const empty = Math.max(0, barWidth - filled);

  const usedStr = validUsed >= 1000 ? `${(validUsed / 1000).toFixed(1)}k` : `${validUsed}`;
  const maxStr = validMax >= 1000 ? `${(validMax / 1000).toFixed(0)}k` : `${validMax}`;
  const validHitRate = Number.isFinite(cacheHitRate) ? Math.max(0, Math.min(100, Math.round(cacheHitRate))) : 0;
  const validCached = Number.isFinite(cachedTokens) ? Math.max(0, cachedTokens) : 0;

  return (
    <Box flexDirection="row" justifyContent="space-between" marginY={0} paddingX={1}>
      <Box gap={1}>
        <Text color="gray">Context:</Text>
        <Text color="red">{'█'.repeat(filled)}</Text>
        <Text color="gray">{'░'.repeat(empty)}</Text>
        <Text color="white" bold>{percent}%</Text>
        <Text color="gray">({usedStr} / {maxStr} tok)</Text>
      </Box>
      <Box gap={1}>
        <Text color="gray">Prompt Cache:</Text>
        <Text color="white" bold>
          {validHitRate}% {validHitRate > 0 ? '(warm)' : '(cold)'}
        </Text>
        {validCached > 0 && (
          <Text color="gray">({validCached >= 1000 ? `${(validCached / 1000).toFixed(1)}k` : validCached} tok)</Text>
        )}
      </Box>
    </Box>
  );
};
