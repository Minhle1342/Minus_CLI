import React from 'react';
import { Box, Text } from 'ink';
import { TuiStepItem } from '../types.js';

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export const LoadingSpinner: React.FC<{ startTime?: number }> = ({ startTime }) => {
  const [frameIndex, setFrameIndex] = React.useState(0);
  const [elapsedMs, setElapsedMs] = React.useState(0);

  React.useEffect(() => {
    const start = startTime || Date.now();
    const interval = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % SPINNER_FRAMES.length);
      setElapsedMs(Date.now() - start);
    }, 80);

    return () => clearInterval(interval);
  }, [startTime]);

  const sec = (elapsedMs / 1000).toFixed(1);

  return (
    <Box gap={1}>
      <Text color="yellow" bold>
        {SPINNER_FRAMES[frameIndex]}
      </Text>
      <Text color="yellow">
        running ({sec}s)
      </Text>
    </Box>
  );
};

interface StepStreamProps {
  steps: TuiStepItem[];
  maxVisible?: number;
}

export const StepStream: React.FC<StepStreamProps> = ({ steps, maxVisible = 12 }) => {
  const visibleSteps = steps.slice(-maxVisible);

  if (visibleSteps.length === 0) {
    return (
      <Box paddingX={1} marginY={0}>
        <Text color="gray" italic>Chưa có bước thực thi nào...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginY={0} paddingX={1}>
      {visibleSteps.map((step) => {
        const p = step.phase;
        let phaseColor = 'gray';
        if (p === 'EXPLORE') phaseColor = 'cyan';
        else if (p === 'IMPLEMENT') phaseColor = 'yellow';
        else if (p === 'VERIFY') phaseColor = 'green';
        else if (p === 'RELEASE') phaseColor = 'magenta';

        const isUnlimited = !isFinite(step.maxSteps) || step.maxSteps >= 9999;
        const stepTag = isUnlimited ? `${step.step}/∞` : `${step.step}/${step.maxSteps}`;

        const rawTarget =
          step.args.path ||
          step.args.filePath ||
          step.args.targetFile ||
          step.args.command ||
          step.args.query ||
          step.args.statement ||
          step.args.summary ||
          '';
        const targetStr = rawTarget
          ? ` "${String(rawTarget).length > 35 ? String(rawTarget).slice(0, 32) + '…' : rawTarget}"`
          : '';

        let statusElement: React.ReactNode;
        if (step.status === 'running') {
          statusElement = <LoadingSpinner startTime={step.timestamp} />;
        } else if (step.status === 'failed') {
          statusElement = <Text color="red">✖ failed</Text>;
        } else if (step.result && step.result.stdout !== undefined) {
          statusElement = (
            <Text color="green">
              ✔ {step.result.exitCode === 0 ? 'exit 0' : `exit ${step.result.exitCode}`}
            </Text>
          );
        } else if (step.result && step.result.replacements !== undefined) {
          statusElement = <Text color="green">✔ {step.result.replacements} replaced</Text>;
        } else if (step.result && step.result.created) {
          statusElement = <Text color="green">✔ created</Text>;
        } else if (step.result && step.result.hunksApplied !== undefined) {
          statusElement = <Text color="green">✔ {step.result.hunksApplied} hunks</Text>;
        } else {
          statusElement = <Text color="green">✔ OK</Text>;
        }

        const durationStr = step.durationMs > 0 ? ` (${step.durationMs}ms)` : '';
        const tokStr = step.tokens && step.tokens > 0
          ? ` · ${step.tokens >= 1000 ? `${(step.tokens / 1000).toFixed(1)}k tok` : `${step.tokens} tok`}`
          : '';

        const isError = step.status === 'failed';
        const errDetail = isError && step.result
          ? step.result.error || step.result.message || (step.result.stderr ? String(step.result.stderr).trim().split('\n')[0] : 'Unknown error')
          : null;

        return (
          <Box key={step.id} flexDirection="column">
            <Box gap={1}>
              <Text color={phaseColor} bold>[{p}:{stepTag}]</Text>
              <Text color="cyan">›</Text>
              <Text bold color="white">{step.toolName}</Text>
              <Text color="gray">{targetStr}</Text>
              {statusElement}
              {durationStr && <Text color="gray">{durationStr}</Text>}
              {tokStr && <Text color="gray">{tokStr}</Text>}
            </Box>
            {isError && errDetail && (
              <Box paddingLeft={2}>
                <Text color="red">└─ {String(errDetail).slice(0, 90)}</Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
};
