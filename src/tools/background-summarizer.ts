import fs from 'node:fs';

export interface BackgroundSummaryOptions {
  toolCallId: string;
  toolName?: string;
  rawText: string;
  logPath?: string;
  exitCode?: number;
  targetPath?: string;
  command?: string;
  fieldName?: string;
  llm?: any;
}

// In-memory cache for O(1) lookup
const summaryCache = new Map<string, string>();

/**
 * Generates an instant (< 1ms) heuristic technical summary from raw tool output.
 * Extracts test results, compiler/runtime errors, file exports, or command status.
 */
export function generateFastHeuristicSummary(options: {
  toolName?: string;
  rawText: string;
  exitCode?: number;
  targetPath?: string;
  command?: string;
  fieldName?: string;
}): string {
  const { toolName, rawText, exitCode, targetPath, command, fieldName } = options;
  if (!rawText || !rawText.trim()) {
    return 'Empty output';
  }

  const lines = rawText.split('\n');
  const lineCount = lines.length;

  const findFailReason = () =>
    lines
      .find((l) => !/^\s*\d+\s+fail/i.test(l) && !/^\s*(?:tests|suites|pass|fail)\s+\d+/i.test(l) && /✖|\bFAIL(?:ED)?\b|AssertionError|Error:/i.test(l))
      ?.trim();

  // 1. Check for test framework outputs (Node test runner, Jest, Vitest, Cargo, Mocha)
  const cargoMatch = rawText.match(/test result: (ok|FAILED)\.\s*(\d+)\s+passed;\s*(\d+)\s+failed/i);
  if (cargoMatch) {
    const status = cargoMatch[1];
    const pass = cargoMatch[2];
    const fail = cargoMatch[3];
    return `Cargo test: ${status} (${pass} passed, ${fail} failed)`;
  }

  const mochaPassMatch = rawText.match(/(\d+)\s+passing/i);
  const mochaFailMatch = rawText.match(/(\d+)\s+failing/i);
  if (mochaPassMatch || mochaFailMatch) {
    const pass = mochaPassMatch ? mochaPassMatch[1] : '0';
    const fail = mochaFailMatch ? mochaFailMatch[1] : '0';
    const failCount = parseInt(fail, 10) || 0;
    const passCount = parseInt(pass, 10) || 0;
    if (failCount > 0 || passCount > 0) {
      if (failCount > 0) {
        const failReason = findFailReason();
        return `Tests failed: ${fail} failed, ${pass} passed.${failReason ? ` Top error: ${failReason.slice(0, 100)}` : ''}`;
      }
      return `Tests passed: ${pass} passed (0 failures).`;
    }
  }

  const nodeTestMatch = rawText.match(/(?:(?:ℹ\s+)?tests?\s+(\d+).*?(?:ℹ\s+)?pass\s+(\d+).*?(?:ℹ\s+)?fail\s+(\d+))/is);
  if (nodeTestMatch) {
    const pass = nodeTestMatch[2];
    const fail = nodeTestMatch[3];
    const failCount = parseInt(fail, 10) || 0;
    if (failCount > 0) {
      const failReason = findFailReason();
      return `Tests failed: ${fail} failed, ${pass} passed.${failReason ? ` Top error: ${failReason.slice(0, 100)}` : ''}`;
    }
    return `Tests passed: ${pass} passed (0 failures).`;
  }

  const jestMatch = rawText.match(/Tests:\s*(?:(\d+)\s+failed,?\s*)?(\d+)\s+passed/i);
  if (jestMatch) {
    const fail = jestMatch[1] || '0';
    const pass = jestMatch[2];
    const failCount = parseInt(fail, 10) || 0;
    if (failCount > 0) {
      const failReason = findFailReason();
      return `Tests failed: ${fail} failed, ${pass} passed.${failReason ? ` Top error: ${failReason.slice(0, 100)}` : ''}`;
    }
    return `Tests passed: ${pass} passed (0 failures).`;
  }

  // 2. Check for explicit error or exception lines
  const errorLine = lines.find((l) =>
    /(?:error TS\d+:|\b(?:Error|TypeError|SyntaxError|ReferenceError|AssertionError|FATAL|panic|FAILED):)/i.test(l)
  );
  if (errorLine) {
    const cleanErr = errorLine.trim().slice(0, 120);
    if (exitCode !== undefined && exitCode !== 0) {
      return `Failed (exit ${exitCode}): ${cleanErr}`;
    }
    return `Error detected: ${cleanErr}`;
  }

  // 3. Check for read_file / source code outline
  if (toolName === 'read_file' || fieldName === 'content') {
    const symbolMatches = Array.from(
      rawText.matchAll(/export\s+(?:default\s+)?(?:class|function|interface|type|const)\s+([a-zA-Z0-9_$]+)/g)
    )
      .map((m) => m[1])
      .slice(0, 4);
    const symbolList = symbolMatches.length > 0 ? ` Exports: ${symbolMatches.join(', ')}` : '';
    const fileRef = targetPath ? `File "${targetPath}"` : 'File';
    return `${fileRef} (${lineCount.toLocaleString()} lines).${symbolList}`;
  }

  // 4. Check for command execution outcome
  if (toolName === 'run_command' || command) {
    const cmdRef = command ? `Command "${command.slice(0, 30)}"` : 'Command';
    if (exitCode !== undefined && exitCode !== 0) {
      const lastLine = lines[lines.length - 1]?.trim() || lines[lines.length - 2]?.trim() || '';
      return `${cmdRef} failed (exit ${exitCode}). Last line: ${lastLine.slice(0, 80)}`;
    }
    if (exitCode === 0) {
      return `${cmdRef} succeeded (${lineCount} lines output).`;
    }
  }

  // 5. Fallback summary
  const firstLine = lines[0]?.trim().slice(0, 80) || '';
  return `Output with ${lineCount.toLocaleString()} lines (${rawText.length.toLocaleString()} chars). Starts: "${firstLine}"`;
}

/**
 * Executes or schedules non-blocking background summarization for spilled/truncated tool outputs.
 * Saves summary in RAM cache and adjacent .summary.txt file.
 */
export async function summarizeToolOutputInBackground(options: BackgroundSummaryOptions): Promise<string> {
  const { toolCallId, logPath, rawText } = options;

  // 1. Compute instant heuristic summary
  const heuristicSummary = generateFastHeuristicSummary(options);
  if (toolCallId) {
    summaryCache.set(toolCallId, heuristicSummary);
  }

  // 2. Persist to disk if logPath is provided
  if (logPath) {
    try {
      const summaryFile = `${logPath}.summary.txt`;
      fs.writeFileSync(summaryFile, heuristicSummary, 'utf8');
    } catch {
      // Non-blocking disk write failure is safely ignored
    }
  }

  // 3. Optional async LLM enhancement (fire and forget, non-blocking)
  if (options.llm && typeof options.llm.generate === 'function') {
    void (async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const prompt = `Summarize this tool execution output in EXACTLY 1 concise English sentence (10-20 words):\n\n${rawText.slice(0, 4000)}`;
        const res = await options.llm.generate({ role: 'user', content: prompt }, [], {
          signal: controller.signal,
          functionCallingMode: 'NONE',
        });
        const refined = res?.text?.trim();
        if (refined && refined.length > 10 && refined.length < 250) {
          summaryCache.set(toolCallId, refined);
          if (logPath) {
            fs.writeFileSync(`${logPath}.summary.txt`, refined, 'utf8');
          }
        }
      } catch {
        // Fallback to heuristic summary
      } finally {
        clearTimeout(timeoutId);
      }
    })();
  }

  return heuristicSummary;
}

/**
 * Retrieves the cached or on-disk summary for a tool call ID, or generates one on-the-fly.
 */
export function getToolOutputSummary(toolCallId: string, fallbackText?: string): string | undefined {
  if (summaryCache.has(toolCallId)) {
    return summaryCache.get(toolCallId);
  }

  if (fallbackText) {
    // Check if the fallbackText already contains [Summary: ...]
    const embeddedMatch = fallbackText.match(/\[Summary:\s*([^\]]+)\]/i);
    if (embeddedMatch) {
      const extracted = embeddedMatch[1].trim();
      summaryCache.set(toolCallId, extracted);
      return extracted;
    }

    const computed = generateFastHeuristicSummary({ rawText: fallbackText });
    summaryCache.set(toolCallId, computed);
    return computed;
  }

  return undefined;
}

/**
 * Collapses a multi-line truncated output into a single-line summary with log path reference.
 */
export function collapseTruncatedOutputToSummary(text: string, toolCallId?: string): string {
  if (!text || (!text.includes('TRUNCATED:') && !text.includes('SAVED TO DISK'))) {
    return text;
  }

  // Try to find the spilled log path
  const pathMatch = text.match(/(?:spilled to|SAVED TO DISK:)\s*([^\s\]]+)/i);
  const logPath = pathMatch ? pathMatch[1] : undefined;

  const summary = (toolCallId ? getToolOutputSummary(toolCallId, text) : undefined)
    || getToolOutputSummary('fallback', text)
    || 'Output truncated';

  const logRef = logPath ? ` (Full log: ${logPath})` : '';
  return `[OBSERVATION SUMMARIZED: ${summary}]${logRef}`;
}
