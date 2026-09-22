import React from 'react';
import { Box, Text } from 'ink';
import { TuiStepItem } from '../types.js';

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Chấm tròn nhấp nháy trước tool calling — chỉ dùng Box/Text của Ink + React state.
 * active=true (tool đang chạy): chớp tắt đỏ ●/space mỗi 400ms (space giữ nguyên
 * width 1 cell nên không vỡ layout; dùng space thay vì ○ vì ○ render gần như
 * giống hệt ● trên nhiều font terminal Windows → tưởng là không blink).
 * active=false (đã xong): chấm xám tĩnh để giữ thẳng hàng.
 */
export const BlinkingDot: React.FC<{ active?: boolean }> = ({ active = true }) => {
  const [visible, setVisible] = React.useState(true);

  React.useEffect(() => {
    if (!active) return;
    setVisible(true);
    const timer = setInterval(() => {
      setVisible((v) => !v);
    }, 400);
    return () => clearInterval(timer);
  }, [active]);

  if (!active) {
    return (
      <Text color="gray">●</Text>
    );
  }

  return (
    <Text color="red" bold>{visible ? '●' : ' '}</Text>
  );
};

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
      <Text color="red" bold>
        {SPINNER_FRAMES[frameIndex]}
      </Text>
      <Text color="white">
        running ({sec}s)
      </Text>
    </Box>
  );
};

/**
 * Trích xuất và định dạng đường dẫn đích kèm số dòng startLine/endLine cho các tool đọc và chỉnh sửa file
 */
export function formatToolTargetWithLines(toolName: string, args: Record<string, any>): string {
  if (!args || typeof args !== 'object') return '';

  const filePath =
    args.path ||
    args.filePath ||
    args.targetFile ||
    args.TargetFile ||
    args.AbsolutePath ||
    args.file ||
    '';

  const lowerTool = (toolName || '').toLowerCase();
  const isReadOrEditTool =
    lowerTool.includes('read') ||
    lowerTool.includes('view') ||
    lowerTool.includes('edit') ||
    lowerTool.includes('replace') ||
    lowerTool.includes('patch') ||
    lowerTool.includes('write');

  if (filePath && isReadOrEditTool) {
    // Hỗ trợ ReplacementChunks trong multi_replace_file_content
    const chunks = args.ReplacementChunks || args.replacementChunks || args.chunks;
    if (Array.isArray(chunks) && chunks.length > 0) {
      const starts = chunks
        .map((c: any) => c.StartLine ?? c.startLine)
        .filter((n: any) => typeof n === 'number' && Number.isFinite(n));
      const ends = chunks
        .map((c: any) => c.EndLine ?? c.endLine)
        .filter((n: any) => typeof n === 'number' && Number.isFinite(n));

      if (starts.length > 0 && ends.length > 0) {
        const minStart = Math.min(...starts);
        const maxEnd = Math.max(...ends);
        return `${filePath}:${minStart}-${maxEnd}`;
      }
    }

    const rawStart = args.startLine ?? args.StartLine ?? args.offset;
    const rawEnd = args.endLine ?? args.EndLine;
    const startLine = typeof rawStart === 'number' && Number.isFinite(rawStart) ? rawStart : undefined;
    const endLine = typeof rawEnd === 'number' && Number.isFinite(rawEnd)
      ? rawEnd
      : (typeof args.limit === 'number' && Number.isFinite(args.limit) && startLine !== undefined
          ? startLine + args.limit - 1
          : undefined);

    let lineSuffix = '';
    if (startLine !== undefined && endLine !== undefined) {
      lineSuffix = startLine === endLine ? `:${startLine}` : `:${startLine}-${endLine}`;
    } else if (startLine !== undefined) {
      lineSuffix = `:${startLine}`;
    } else if (endLine !== undefined) {
      lineSuffix = `:1-${endLine}`;
    }

    return `${filePath}${lineSuffix}`;
  }

  return (
    filePath ||
    args.command ||
    args.query ||
    args.statement ||
    args.summary ||
    ''
  );
}

/**
 * Làm sạch và định dạng thông điệp lỗi hiển thị trên TUI
 * Loại bỏ các tiền tố binary path dài dòng (Command failed: ...), ưu tiên dòng lỗi bản chất
 * và không bao giờ để lọt ký tự xuống dòng làm vỡ thụt lề terminal
 */
export function formatTuiErrorDetail(rawErr: unknown, maxLen = 140): string {
  if (!rawErr) return '';
  let errStr = typeof rawErr === 'object' && rawErr !== null
    ? ((rawErr as any).message || (rawErr as any).error || JSON.stringify(rawErr))
    : String(rawErr);

  // Nếu chuỗi chứa nhiều dòng, chuẩn hóa
  const lines = errStr.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';

  // 1. Xử lý [SYSTEM EVIDENCE GATE]
  if (/\[SYSTEM EVIDENCE GATE\]/i.test(errStr)) {
    const reasonLine = lines.find((l: string) => /^-\s+|^•\s+|^(?:No successful|The request|The final answer)/i.test(l));
    if (reasonLine) {
      const cleanReason = reasonLine.replace(/^[-•]\s*/, '').trim();
      errStr = `[SYSTEM EVIDENCE GATE]: ${cleanReason}`;
    } else {
      errStr = lines[0];
    }
  }
  // 2. Xử lý [CRITIC GATE REJECTION]
  else if (/\[CRITIC GATE REJECTION/i.test(errStr)) {
    const reasonLine = lines.find((l: string) => /^(?:❌|•|\[HARD)/i.test(l));
    if (reasonLine) {
      errStr = `[CRITIC GATE]: ${reasonLine.replace(/^[❌•]\s*/, '').trim()}`;
    } else {
      errStr = lines[0];
    }
  }
  // 3. Xử lý các trường hợp chứa "Command failed: C:\...\node.exe ..."
  else if (/Command failed:\s*/i.test(errStr)) {
    // 1. Tìm dòng lỗi ngoại lệ thực sự (TypeError, SyntaxError, Error, v.v.)
    const exceptionLine = lines.find((l: string) =>
      /(?:(?:[A-Z][a-zA-Z0-9_]*Error|Error|FATAL ERROR|ERR_[A-Z0-9_]+)(?:\s*\[[^\]]+\])?:\s*[^\n]+)/.test(l) &&
      !/^Command failed:\s*/i.test(l)
    );

    if (exceptionLine) {
      // Nếu có tiền tố như "Script execution failed with exit code X: Command failed: ...", giữ tiền tố thoát code
      const exitCodePrefix = errStr.match(/^(?:Script execution failed with exit code \d+|Command failed with exit code \d+):/i);
      errStr = exitCodePrefix ? `${exitCodePrefix[0]} ${exceptionLine}` : exceptionLine;
    } else {
      // Tìm dòng không phải command invocation, không phải stack trace
      const nonCmdLines = lines.filter((l: string) => !/^Command failed:\s*/i.test(l) && !/^at\s+/i.test(l) && !/^\^/i.test(l) && !/^Node\.js v/i.test(l));
      if (nonCmdLines.length > 0) {
        const exitCodePrefix = errStr.match(/^(?:Script execution failed with exit code \d+|Command failed with exit code \d+):/i);
        errStr = exitCodePrefix ? `${exitCodePrefix[0]} ${nonCmdLines[0]}` : nonCmdLines[0];
      } else {
        // Nếu chỉ có 1 dòng Command failed, loại bỏ đường dẫn thư mục tuyệt đối dài dòng
        // VD: Command failed: C:\Program Files\nodejs\node.exe D:\path\file.mjs -> Command failed: node.exe file.mjs
        errStr = errStr.replace(/Command failed:\s*"?.*[/\\]([a-zA-Z0-9_.-]+(?:\.exe)?)"?/i, 'Command failed: $1');
      }
    }
  }

  // Chuyển toàn bộ ký tự xuống dòng thành dấu cách để đảm bảo output luôn nằm gọn trên 1 dòng
  const singleLine = errStr.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxLen) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLen - 1)}…`;
}

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
        const args = (step && typeof step.args === 'object' && step.args !== null) ? step.args : {};
        const rawTarget = formatToolTargetWithLines(step.toolName, args);
        const displayTarget = rawTarget.length > 40 && (rawTarget.includes('/') || rawTarget.includes('\\') || rawTarget.includes(':'))
          ? '…' + rawTarget.slice(-37)
          : (rawTarget.length > 40 ? rawTarget.slice(0, 37) + '…' : rawTarget);
        const targetStr = rawTarget ? ` "${displayTarget}"` : '';

        let statusElement: React.ReactNode;
        if (step.status === 'running') {
          statusElement = <LoadingSpinner startTime={step.timestamp} />;
        } else if (step.status === 'failed') {
          statusElement = <Text color="red">✖ failed</Text>;
        } else if (step.result && step.result.stdout !== undefined) {
          statusElement = (
            <Text color="white">
              ✔ {step.result.exitCode === 0 ? 'exit 0' : `exit ${step.result.exitCode}`}
            </Text>
          );
        } else if (step.result && step.result.replacements !== undefined) {
          statusElement = <Text color="white">✔ {step.result.replacements} replaced</Text>;
        } else if (step.result && step.result.created) {
          statusElement = <Text color="white">✔ created</Text>;
        } else if (step.result && step.result.hunksApplied !== undefined) {
          statusElement = <Text color="white">✔ {step.result.hunksApplied} hunks</Text>;
        } else {
          statusElement = <Text color="white">✔ OK</Text>;
        }

        const durationStr = step.durationMs > 0 ? ` (${step.durationMs}ms)` : '';
        const tokStr = step.tokens && step.tokens > 0
          ? ` · ${step.tokens >= 1000 ? `${(step.tokens / 1000).toFixed(1)}k tok` : `${step.tokens} tok`}`
          : '';

        const isError = step.status === 'failed';
        const rawErr = isError && step.result
          ? (typeof step.result.error === 'object' && step.result.error !== null
              ? (step.result.error.message || JSON.stringify(step.result.error))
              : step.result.error) ||
            step.result.message ||
            (step.result.stderr ? String(step.result.stderr).trim().split('\n')[0] : 'Unknown error')
          : null;
        const errDetail = rawErr ? formatTuiErrorDetail(rawErr) : null;

        return (
          <Box key={step.id} flexDirection="column">
            <Box gap={1}>
              <BlinkingDot active={step.status === 'running'} />
              <Text bold color="white">{step.toolName}</Text>
              <Text color="gray">{targetStr}</Text>
              {statusElement}
              {durationStr && <Text color="gray">{durationStr}</Text>}
              {tokStr && <Text color="gray">{tokStr}</Text>}
            </Box>
            {isError && errDetail && (
              <Box paddingLeft={2}>
                <Text color="red">└─ {errDetail}</Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
};
