import React from 'react';
import { Box, Text } from 'ink';
import { inkColors } from '../../tui-theme.js';

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
  const barWidth = 8;
  const filled = Number.isFinite(percent) ? Math.min(barWidth, Math.max(0, Math.round((percent / 100) * barWidth))) : 0;
  const empty = Math.max(0, barWidth - filled);

  const usedStr = validUsed >= 1000 ? `${(validUsed / 1000).toFixed(1)}k` : `${validUsed}`;
  const maxStr = validMax >= 1000 ? `${(validMax / 1000).toFixed(0)}k` : `${validMax}`;
  const validHitRate = Number.isFinite(cacheHitRate) ? Math.max(0, Math.min(100, Math.round(cacheHitRate))) : 0;
  const validCached = Number.isFinite(cachedTokens) ? Math.max(0, cachedTokens) : 0;

  const usageColor = percent >= 85 ? inkColors.danger : percent >= 65 ? inkColors.warning : inkColors.accent;

  return (
    <Box flexDirection="column" marginY={0} paddingX={1}>
      <Text>
        <Text color={inkColors.muted}>Context </Text>
        <Text color={usageColor}>{'█'.repeat(filled)}</Text>
        <Text color={inkColors.muted}>{'░'.repeat(empty)}</Text>
        <Text bold> {percent}%</Text>
        <Text color={inkColors.muted}> {usedStr}/{maxStr}</Text>
      </Text>
      <Text>
        <Text color={inkColors.muted}>Cache </Text>
        <Text bold>{validHitRate}%</Text>
        <Text color={inkColors.muted}> {validHitRate > 0 ? 'warm' : 'cold'}</Text>
        {validCached > 0 && (
          <Text color={inkColors.muted}> · {validCached >= 1000 ? `${(validCached / 1000).toFixed(1)}k` : validCached} tok</Text>
        )}
      </Text>
    </Box>
  );
};
