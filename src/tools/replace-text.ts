import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createPatch } from 'diff';
import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { CodeSyntaxValidator } from '../workspace/syntax-diagnostics.js';
import {
  detectChangedSymbols,
  calculateComprehensiveBlastRadius,
  invalidateTopologyCache,
} from './mutation-blast-radius.js';

type MatchStrategy = 'exact' | 'normalized_eol' | 'normalized_indentation' | 'normalized_unicode' | 'normalized_whitespace' | 'normalized_line_numbers' | 'empty_file_initialization';

export interface TextMatch {
  start: number;
  end: number;
  line: number;
  strategy: MatchStrategy;
  /** Strategy that actually matched after line-number prefixes were stripped. */
  baseStrategy?: MatchStrategy;
  indentation?: string;
  lineNumbersStripped?: boolean;
}

interface NormalizedText {
  text: string;
  /** boundaries[n] is the original offset after n normalized characters. */
  boundaries: number[];
}

/**
 * Tool 4: replace_text
 * Thay thế một đoạn văn bản/code chính xác (surgical edit) trong một file.
 * Bắt buộc oldText phải khớp duy nhất 1 lần để tránh sửa nhầm chỗ.
 */
export const replaceTextTool: ToolDefinition = {
  name: 'replace_text',
  description: 'Replace one oldText block in a file. Bug/error fix workflow: (1) Explore & diagnose: Run `run_command` (e.g. tests, linter, typecheck, or `rg -n`) to reproduce the error, capture failure diagnostics, and locate failure lines/stack traces. (2) Read context: Call `read_file` with startLine/endLine around the target site to inspect surrounding code and retrieve its latest contentHash. (3) Edit: Call `replace_text` with a unique 3–15-line anchor in oldText, the fix in newText, and expectedFileHash. (4) Verify: Immediately re-run `run_command` (tests/build) to confirm the fix works and prevent regressions. Auto mode safely handles LF/CRLF, Unicode (NFC/NFD), indentation, and read_file line-number prefixes in multi-line blocks without fuzzy semantic matching: read_file "N: " line-number prefixes are auto-stripped when every non-empty line is numbered and the numbers align, while misaligned numbering fails with cause LINE_NUMBER_PREFIX. Prefer a concise, unique 3–15-line anchor copied from the current file contents; avoid sending blocks larger than 50 lines. Pass the latest contentHash from read_file as expectedFileHash. On TEXT_NOT_FOUND, inspect cause and retry with suggestedOldText + suggestedStartLine/suggestedEndLine + contentHash when provided instead of re-reading. If the tool returns FILE_CONTENT_CHANGED, do not retry with the old text or merely swap in the returned hash: re-read the current file, review its changes, rebuild oldText/newText against that version, and retry with its new contentHash. Do not omit the hash to bypass a conflict.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: 'Workspace-relative path to the file to edit (for example, "src/index.ts").',
      },
      oldText: {
        type: Type.STRING,
        description: 'Original text or code copied from the latest read_file content (not a stale earlier read or truncated preview). Always inspect the file with read_file first after locating the bug/error via run_command. Use a unique 3–15-line anchor; LF/CRLF, Unicode composed/decomposed differences, indentation, and read_file "N: " line-number prefixes are handled automatically. When a call fails, prefer the returned suggestedOldText as the next oldText.',
      },
      newText: {
        type: Type.STRING,
        description: 'New text or code that replaces oldText.',
      },
      matchMode: {
        type: Type.STRING,
        enum: ['auto', 'exact'],
        description: 'auto (default) accepts equivalent LF/CRLF, Unicode, indentation, and read_file line-number prefixes; exact matches byte-for-byte only (line-number prefixes are not stripped).',
      },
      expectedFileHash: {
        type: Type.STRING,
        description: 'Latest contentHash returned by read_file. Always pass it for edits. If it mismatches, re-read and re-evaluate the edit against the current contents; never blindly retry with the new hash or omit this guard.',
      },
      expectedOccurrences: {
        type: Type.INTEGER,
        description: 'Expected number of oldText occurrences; tool gates that only 1 occurrence matches and replaces the first location, so typically use 1 unless you need to target multiple identical anchors per file edit.',
      },
    },
    required: ['path', 'oldText', 'newText'],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const rawPath = String(args.path || args.filePath || args.targetFile || args.TargetFile || '');
    let oldText = args.oldText;
    if (!oldText || (typeof oldText === 'string' && oldText.trim() === '')) {
      oldText = args.old_text ?? args.TargetContent ?? args.targetContent ?? args.searchContent ?? args.searchText ?? args.oldContent ?? '';
    }
    oldText = String(oldText ?? '');

    let newText = args.newText;
    if (newText === undefined || newText === null) {
      newText = args.new_text ?? args.ReplacementContent ?? args.replacementContent ?? args.replaceWith ?? args.newContent ?? '';
    }
    newText = String(newText ?? '');

    const matchMode = args.matchMode === 'exact' ? 'exact' : 'auto';
    const expectedOccurrences = typeof args.expectedOccurrences === 'number' ? args.expectedOccurrences : 1;
    const expectedFileHash = args.expectedFileHash === undefined
      ? undefined
      : String(args.expectedFileHash).trim();

    if (!rawPath) {
      return { success: false, error: 'The "path" parameter is required.', errorCode: 'INVALID_ARGS' };
    }
    if (!oldText) {
      return {
        success: false,
        error: 'The "oldText" parameter must not be empty. replace_text requires an existing anchor code block to replace. To overwrite an entire file or create a new file, use the "write_file" tool.',
        errorCode: 'INVALID_ARGS',
        suggestedAction: 'Provide the code to replace in "oldText", or use the write_file tool to create/overwrite an entire file.',
      };
    }

    try {
      const safePath = workspace.resolveSafePath(rawPath);

      if (workspace.isProtectedFile(safePath)) {
        return {
          success: false,
          path: rawPath,
          error: `Security: editing or overwriting sensitive configuration file "${rawPath}" is not allowed.`,
          errorCode: 'SECURITY_VIOLATION',
        };
      }

      let stat;
      try {
        stat = await fs.stat(safePath);
      } catch (statErr: any) {
        if (statErr.code === 'ENOENT') {
          let similarFiles: string[] = [];
          try {
            similarFiles = await workspace.findSimilarWorkspaceFiles(rawPath, 3);
          } catch {}
          const similarMsg = similarFiles.length > 0
            ? ` Found similar file(s) in the workspace: ${JSON.stringify(similarFiles)}. Call replace_text with the correct path "${similarFiles[0]}", or use "write_file" to create a new file.`
            : ' Use "write_file" if you want to create a new file.';
          return {
            success: false,
            path: rawPath,
            error: `File "${rawPath}" does not exist (ENOENT).${similarMsg}`,
            errorCode: 'FILE_NOT_FOUND',
            similarFiles: similarFiles.length > 0 ? similarFiles : undefined,
            suggestion: similarFiles.length > 0
              ? `Switch to editing file "${similarFiles[0]}" or create "${rawPath}" via write_file.`
              : `Create file "${rawPath}" via the write_file tool.`,
          };
        }
        throw statErr;
      }

      if (!stat.isFile()) {
        return { success: false, path: rawPath, error: `"${rawPath}" is not a file.`, errorCode: 'NOT_A_FILE' };
      }

      const content = await fs.readFile(safePath, 'utf-8');
      const observedFileHash = hashContent(content);
      if (expectedFileHash && !isHashMatch(expectedFileHash, observedFileHash)) {
        return {
          success: false,
          path: rawPath,
          error: `File "${rawPath}" contentHash does not match expectedFileHash; the replacement was blocked to avoid overwriting new content.`,
          errorCode: 'FILE_CONTENT_CHANGED',
          expectedFileHash,
          observedFileHash,
          suggestion: `Re-read the latest content of "${rawPath}" with read_file, review the changes, rebuild oldText/newText against the current content, then call replace_text with the new expectedFileHash. Do not reuse the old oldText, do not just swap the hash per the hint, and do not drop expectedFileHash.`,
        };
      }

      // Xử lý tự động khởi tạo khi file rỗng (0 bytes / whitespace only)
      if (content.trim() === '') {
        const preCheckSyntaxErrors = CodeSyntaxValidator.validateContentSyntax(rawPath, newText);
        if (preCheckSyntaxErrors.length > 0) {
          return {
            success: false,
            path: rawPath,
            error: `Edit blocked by In-Memory Syntax Guardrail: detected ${preCheckSyntaxErrors.length} syntax error(s) in the new content.`,
            errorCode: 'SYNTAX_ERROR_PREVENTED',
            syntaxErrors: preCheckSyntaxErrors,
            diagnostic: `New syntax breaks at line ${preCheckSyntaxErrors[0].line}: ${preCheckSyntaxErrors[0].message}`,
            suggestion: `Fix the syntax in newText before calling replace_text again: ${preCheckSyntaxErrors[0].message}.`,
          };
        }
        await fs.writeFile(safePath, newText, 'utf-8');
        invalidateTopologyCache();
        return {
          path: rawPath,
          success: true,
          matchStrategy: 'empty_file_initialization',
          line: 1,
          previousContentHash: observedFileHash,
          contentHash: hashContent(newText),
          message: `Initialized content for empty file "${rawPath}".`,
        };
      }

      const matches = findTextMatches(content, oldText, matchMode);
      if (matches.length === 0) {
        const candidates = findNearbyCandidates(content, oldText);
        const { cause, hint } = classifyTextNotFoundCause(content, oldText, candidates);
        const suggestedWindow = candidates[0]
          ? buildSuggestedEditWindow(content, oldText, candidates[0].line)
          : undefined;
        const fullSuggestedWindow = suggestedWindow && !suggestedWindow.truncated ? suggestedWindow : undefined;
        const suggestedRead = suggestedWindow
          ? { path: rawPath, startLine: Math.max(1, suggestedWindow.startLine - 3), endLine: suggestedWindow.startLine + Math.min(suggestedWindow.anchorLineCount, MAX_SUGGESTED_READ_LINES) - 1 + 3, includeLineNumbers: false }
          : { path: rawPath, includeLineNumbers: false };
        let diagnostic = 'oldText differs from the current content; the "..." preview on the CLI is only a truncated display and must not be copied as source.';
        if (oldText.length > 1000) {
          diagnostic += ` Warning: oldText is too long (${oldText.length} chars). Narrow oldText to a unique 3-15 line anchor to avoid character drift.`;
        }
        const anchorDiffHint = candidates[0] ? analyzeCandidateDiff(anchorLineOf(oldText), candidates[0].preview) : undefined;
        const candidateDiffHint = hint || anchorDiffHint;
        const retryWithSnippet = fullSuggestedWindow
          ? `Use suggestedOldText (lines ${fullSuggestedWindow.startLine}-${fullSuggestedWindow.endLine}, raw content without line numbers) as oldText and pass contentHash as expectedFileHash; no re-read is needed.`
          : suggestedWindow
            ? `oldText exceeds the ${MAX_SUGGESTED_EDIT_LINES}-line snippet limit; call read_file with ${JSON.stringify(suggestedRead)}, rebuild a unique anchor, then retry with contentHash.`
            : '';
        return {
          success: false,
          path: rawPath,
          error: `oldText not found in "${rawPath}" after exact, LF/CRLF, Unicode, whitespace, indentation and line-number-prefix checks.`,
          errorCode: 'TEXT_NOT_FOUND',
          cause,
          diagnostic,
          candidateDiffHint,
          observedFileHash,
          contentHash: observedFileHash,
          oldTextLength: oldText.length,
          candidates,
          suggestedOldText: fullSuggestedWindow?.text,
          suggestedStartLine: fullSuggestedWindow?.startLine,
          suggestedEndLine: fullSuggestedWindow?.endLine,
          suggestedRead,
          suggestion: candidateDiffHint
            ? `Detected (${cause}): ${candidateDiffHint}${retryWithSnippet ? ` ${retryWithSnippet}` : ' Adjust oldText or re-read via read_file.'}`
            : retryWithSnippet
              ? retryWithSnippet
              : `Call read_file with ${JSON.stringify(suggestedRead)}, get the raw content (without line numbers), then call replace_text again with the new contentHash.`,
        };
      }

      if (matches.length !== expectedOccurrences) {
        return {
          success: false,
          path: rawPath,
          error: `oldText matches ${matches.length} location(s) in "${rawPath}" (expected: ${expectedOccurrences}); the operation was blocked to avoid wrong edits.`,
          errorCode: 'TEXT_NOT_UNIQUE',
          occurrences: matches.length,
          actualOccurrences: matches.length,
          expectedOccurrences,
          candidateLines: matches.slice(0, 10).map((match) => match.line),
          observedFileHash,
          suggestion: 'Re-read a narrow line range and add a unique context to oldText.',
        };
      }

      const match = matches[0];
      let effectiveNewText = newText;
      if (match.lineNumbersStripped) {
        const strippedNew = stripLineNumberPrefixes(newText);
        const strippedOld = stripLineNumberPrefixes(oldText);
        if (strippedNew && strippedOld && strippedNew.blockStartLine === strippedOld.blockStartLine) {
          effectiveNewText = strippedNew.text;
        }
      }
      const replacement = prepareReplacement(effectiveNewText, content, match);
      const updatedContent = content.slice(0, match.start) + replacement + content.slice(match.end);

      // In-Memory AST Syntax Validation Guardrail (SWE-agent ACI Standard)
      // Chặn ghi đĩa nếu phát hiện lỗi cú pháp mới xuất hiện trong updatedContent
      const preCheckSyntaxErrors = CodeSyntaxValidator.validateContentSyntax(rawPath, updatedContent);
      if (preCheckSyntaxErrors.length > 0) {
        const originalSyntaxErrors = CodeSyntaxValidator.validateContentSyntax(rawPath, content);
        const newSyntaxErrors = preCheckSyntaxErrors.filter(
          (se) => !originalSyntaxErrors.some((oe) => oe.code === se.code && Math.abs(oe.line - se.line) <= 2),
        );
        if (newSyntaxErrors.length > 0) {
          return {
            success: false,
            path: rawPath,
            error: `Edit blocked by In-Memory Syntax Guardrail: detected ${newSyntaxErrors.length} new syntax error(s) in the content before writing to disk.`,
            errorCode: 'SYNTAX_ERROR_PREVENTED',
            syntaxErrors: newSyntaxErrors,
            diagnostic: `New syntax breaks at line ${newSyntaxErrors[0].line}: ${newSyntaxErrors[0].message}`,
            suggestion: `Fix the syntax in newText before calling replace_text again: ${newSyntaxErrors[0].message}. The on-disk file was not changed.`,
          };
        }
      }

      // Detect a concurrent/stale edit between the initial read and the write.
      const latestContent = await fs.readFile(safePath, 'utf-8');
      if (latestContent !== content) {
        return {
          success: false,
          path: rawPath,
          error: `File "${rawPath}" changed while replace_text was processing; no data was overwritten.`,
          errorCode: 'FILE_CHANGED_DURING_EDIT',
          expectedFileHash: observedFileHash,
          observedFileHash: hashContent(latestContent),
          suggestion: `Re-read "${rawPath}" then apply the change on the latest version.`,
        };
      }

      await fs.writeFile(safePath, updatedContent, 'utf-8');
      invalidateTopologyCache();

      let blastRadiusSummary: any;
      try {
        const modifiedSymbols = detectChangedSymbols(rawPath, content, updatedContent);
        const blast = calculateComprehensiveBlastRadius({
          workspace,
          filePath: rawPath,
          modifiedSymbols,
          depth: 2,
        });
        blastRadiusSummary = {
          risk: blast.risk,
          score: blast.score,
          depth: blast.depth,
          modifiedSymbols: blast.modifiedSymbols.map((s) => s.name),
          directConsumers: blast.directConsumers,
          transitiveFiles: blast.transitiveFiles,
          impactedTestSuites: blast.impactedTestSuites,
          callersCount: blast.callers.length,
          publicApiAffected: blast.publicApiAffected,
          breakingChange: blast.breakingChange,
          warnings: blast.warnings,
          recommendedActions: blast.recommendedActions,
        };
      } catch {}

      let diagnosticWarning: string | undefined;
      let syntaxErrors: any[] | undefined;
      try {
        const diags = await CodeSyntaxValidator.validateFile(rawPath, workspace);
        if (diags.length > 0) {
          syntaxErrors = diags;
          diagnosticWarning = `⚠️ LINTER ALERT (${diags.length} unresolved syntax / missing import issue(s)):\n` +
            diags.map((d) => `  • Line ${d.line}: ${d.message}`).join('\n') +
            `\n👉 ACTION REQUIRED: Add the missing import statement at the top of "${rawPath}" or fix the syntax error now.`;
        }
      } catch {}

      let unifiedDiff: string | undefined;
      try {
        const patch = createPatch(rawPath, content, updatedContent, 'before', 'after');
        unifiedDiff = patch.length > 4000 ? patch.slice(0, 4000) + '\n... [diff truncated]' : patch;
      } catch {}

      return {
        path: rawPath,
        success: true,
        matchStrategy: match.strategy,
        ...(match.lineNumbersStripped ? { lineNumbersStripped: true, baseMatchStrategy: match.baseStrategy } : {}),
        line: match.line,
        previousContentHash: observedFileHash,
        contentHash: hashContent(updatedContent),
        message: `Successfully replaced 1 location in "${rawPath}".`,
        ...(unifiedDiff ? { unifiedDiff } : {}),
        ...(blastRadiusSummary ? { blastRadius: blastRadiusSummary } : {}),
        ...(diagnosticWarning ? { diagnosticWarning, syntaxErrors } : {}),
      };
    } catch (err: any) {
      return {
        success: false,
        path: rawPath,
        error: `Failed to replace file content: ${err.message}`,
        errorCode: 'EXECUTION_ERROR',
      };
    }
  },
};

export function findTextMatches(content: string, oldText: string, mode: 'auto' | 'exact'): TextMatch[] {
  const exact = findAllRanges(content, oldText).map(({ start, end }) => ({
    start,
    end,
    line: lineNumberAt(content, start),
    strategy: 'exact' as const,
  }));
  if (mode === 'exact') return exact;

  return findAutoMatches(content, oldText, true);
}

function findAutoMatches(content: string, oldText: string, allowLineNumberFallback: boolean): TextMatch[] {
  const normalizedContent = normalizeLineEndingsWithBoundaries(content);
  const normalizedOldText = normalizeLineEndingsWithBoundaries(oldText).text;
  const eolEquivalent = findAllRanges(normalizedContent.text, normalizedOldText).map(({ start, end }) => {
    const rawSlice = content.slice(normalizedContent.boundaries[start], normalizedContent.boundaries[end]);
    let strategy: MatchStrategy = 'exact';
    if (rawSlice !== oldText) {
      if (rawSlice.replace(/\r\n/g, '\n') === oldText.replace(/\r\n/g, '\n')) {
        strategy = 'normalized_eol';
      } else if (rawSlice.normalize('NFC') === oldText.normalize('NFC')) {
        strategy = 'normalized_unicode';
      } else {
        strategy = 'normalized_eol';
      }
    }
    return {
      start: normalizedContent.boundaries[start],
      end: normalizedContent.boundaries[end],
      line: lineNumberAt(normalizedContent.text, start),
      strategy,
    };
  });
  if (eolEquivalent.length > 0) return eolEquivalent;

  const indentMatches = findIndentationEquivalentMatches(content, normalizedContent, normalizedOldText);
  if (indentMatches.length > 0) return indentMatches;

  const whitespaceMatches = findWhitespaceEquivalentMatches(content, normalizedContent, normalizedOldText);
  if (whitespaceMatches.length > 0) return whitespaceMatches;

  return allowLineNumberFallback ? findLineNumberStrippedMatches(content, oldText) : [];
}

interface StrippedLineNumbers {
  text: string;
  blockStartLine: number;
}

/**
 * read_file defaults to "N: content" output. Strip that prefix only when every
 * non-empty line is numbered and the numbers advance with the line offset, so
 * legitimate content that happens to start with "1: " is left untouched.
 */
function stripLineNumberPrefixes(value: string): StrippedLineNumbers | undefined {
  const normalized = normalizeLineEndingsWithBoundaries(value).text;
  const hasTrailingEol = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (hasTrailingEol) lines.pop();

  const strippedLines: string[] = [];
  const numbered: Array<{ index: number; number: number }> = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim() === '') {
      strippedLines.push('');
      continue;
    }
    const prefix = line.match(/^\s*(\d+):[ \t]?/);
    if (!prefix) return undefined;
    numbered.push({ index, number: Number(prefix[1]) });
    strippedLines.push(line.slice(prefix[0].length));
  }
  if (numbered.length === 0) return undefined;

  const first = numbered[0];
  const numbersAdvanceWithLines = numbered.every(
    (entry) => entry.number === first.number + (entry.index - first.index),
  );
  if (!numbersAdvanceWithLines) return undefined;

  return {
    text: strippedLines.join('\n') + (hasTrailingEol ? '\n' : ''),
    blockStartLine: first.number - first.index,
  };
}

function findLineNumberStrippedMatches(content: string, oldText: string): TextMatch[] {
  const stripped = stripLineNumberPrefixes(oldText);
  if (!stripped) return [];

  return findAutoMatches(content, stripped.text, false)
    .filter((match) => match.line === stripped.blockStartLine)
    .map((match) => ({
      ...match,
      strategy: 'normalized_line_numbers' as const,
      baseStrategy: match.strategy,
      lineNumbersStripped: true,
    }));
}

function findWhitespaceEquivalentMatches(
  originalContent: string,
  normalizedContent: NormalizedText,
  normalizedOldText: string,
): TextMatch[] {
  const oldHasTrailingEol = normalizedOldText.endsWith('\n');
  const oldLines = normalizedOldText.split('\n');
  if (oldHasTrailingEol) oldLines.pop();
  if (oldLines.length === 0) return [];

  const cleanMarkup = (line: string) =>
    (line || '')
      .replace(/\t/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\s*=\s*/g, '=')
      .replace(/['"`]/g, '"')
      .replace(/\s*\/?>/g, '>')
      .trim();

  const cleanedOld = oldLines.map(cleanMarkup).join('\n');
  if (!cleanedOld) return [];

  const contentLines = splitLines(normalizedContent.text);
  const matches: TextMatch[] = [];

  for (let index = 0; index + oldLines.length <= contentLines.length; index++) {
    const window = contentLines.slice(index, index + oldLines.length);
    const cleanedWindow = window.map((line) => cleanMarkup(line.text)).join('\n');
    if (cleanedWindow !== cleanedOld) continue;

    const first = window[0];
    const last = window[window.length - 1];
    const normalizedEnd = oldHasTrailingEol && last.hasEol ? last.end + 1 : last.end;
    const targetIndent = (first.text || '').match(/^(\s*)/)?.[1] || '';

    matches.push({
      start: normalizedContent.boundaries[first.start],
      end: normalizedContent.boundaries[normalizedEnd],
      line: index + 1,
      strategy: 'normalized_whitespace',
      indentation: targetIndent,
    });
  }

  return matches.filter((match) => match.start <= match.end && match.end <= originalContent.length);
}

function findIndentationEquivalentMatches(
  originalContent: string,
  normalizedContent: NormalizedText,
  normalizedOldText: string,
): TextMatch[] {
  const oldHasTrailingEol = normalizedOldText.endsWith('\n');
  const oldLines = normalizedOldText.split('\n');
  if (oldHasTrailingEol) oldLines.pop();
  if (oldLines.length < 2 || oldLines.filter((line) => line.trim().length > 0).length < 2) return [];

  const contentLines = splitLines(normalizedContent.text);
  const expected = canonicalizeIndentedBlock(oldLines).canonical;
  const matches: TextMatch[] = [];
  for (let index = 0; index + oldLines.length <= contentLines.length; index++) {
    const window = contentLines.slice(index, index + oldLines.length);
    const canonical = canonicalizeIndentedBlock(window.map((line) => line.text));
    if (canonical.canonical !== expected) continue;
    const first = window[0];
    const last = window[window.length - 1];
    const normalizedEnd = oldHasTrailingEol && last.hasEol ? last.end + 1 : last.end;
    matches.push({
      start: normalizedContent.boundaries[first.start],
      end: normalizedContent.boundaries[normalizedEnd],
      line: index + 1,
      strategy: 'normalized_indentation',
      indentation: canonical.indentation,
    });
  }
  return matches.filter((match) => match.start <= match.end && match.end <= originalContent.length);
}

function prepareReplacement(newText: string, content: string, match: TextMatch): string {
  const eol = detectLocalEol(content.slice(match.start, match.end)) || detectDominantEol(content);
  let normalized = normalizeLineEndingsWithBoundaries(newText).text;
  const effectiveStrategy = match.baseStrategy ?? match.strategy;
  if (effectiveStrategy === 'normalized_indentation' || effectiveStrategy === 'normalized_whitespace') {
    const hasTrailingEol = normalized.endsWith('\n');
    const lines = normalized.split('\n');
    if (hasTrailingEol) lines.pop();
    const dedented = canonicalizeIndentedBlock(lines).lines;
    normalized = dedented
      .map((line) => line ? `${match.indentation || ''}${line}` : '')
      .join('\n') + (hasTrailingEol ? '\n' : '');
  }
  return normalized.replace(/\n/g, eol);
}

const graphemeSegmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

function normalizeLineEndingsWithBoundaries(value: string): NormalizedText {
  let text = '';
  const boundaries = [0];
  for (const seg of graphemeSegmenter.segment(value)) {
    let s = seg.segment;
    if (s === '\r\n' || s === '\r') {
      s = '\n';
    } else {
      s = s.normalize('NFC');
    }
    for (let index = 0; index < s.length; index++) {
      text += s[index];
      boundaries.push(seg.index + seg.segment.length);
    }
  }
  return { text, boundaries };
}

function findAllRanges(content: string, needle: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  while (cursor <= content.length - needle.length) {
    const start = content.indexOf(needle, cursor);
    if (start < 0) break;
    ranges.push({ start, end: start + needle.length });
    cursor = start + Math.max(1, needle.length);
  }
  return ranges;
}

function splitLines(content: string): Array<{ text: string; start: number; end: number; hasEol: boolean }> {
  const lines: Array<{ text: string; start: number; end: number; hasEol: boolean }> = [];
  let start = 0;
  for (let index = 0; index < content.length; index++) {
    if (content[index] !== '\n') continue;
    lines.push({ text: content.slice(start, index), start, end: index, hasEol: true });
    start = index + 1;
  }
  lines.push({ text: content.slice(start), start, end: content.length, hasEol: false });
  return lines;
}

function canonicalizeIndentedBlock(lines: string[]): { canonical: string; lines: string[]; indentation: string } {
  const trimmedRight = lines.map((line) => line.replace(/[ \t]+$/g, ''));
  const nonEmpty = trimmedRight.filter((line) => line.trim().length > 0);
  const indentationLength = nonEmpty.length === 0
    ? 0
    : Math.min(...nonEmpty.map((line) => line.match(/^[ \t]*/)?.[0].length || 0));
  const indentation = nonEmpty[0]?.slice(0, indentationLength) || '';
  const dedented = trimmedRight.map((line) => line.trim() ? line.slice(indentationLength) : '');
  return { canonical: dedented.join('\n'), lines: dedented, indentation };
}

type TextNotFoundCause =
  | 'LINE_NUMBER_PREFIX'
  | 'TRUNCATION_MARKER'
  | 'BLANK_LINE_DRIFT'
  | 'STALE_CONTENT'
  | 'UNKNOWN';

const TRUNCATION_MARKERS = [
  '... [truncated',
  '[... Truncated',
  '[OUTPUT TRUNCATED',
  'FULL TOOL OUTPUT SAVED TO DISK',
  '[diff truncated]',
];

function anchorLineOf(text: string): string {
  return normalizeLineEndingsWithBoundaries(text).text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function classifyTextNotFoundCause(
  content: string,
  oldText: string,
  candidates: Array<{ line: number; preview: string; score: number }>,
): { cause: TextNotFoundCause; hint?: string } {
  const stripped = stripLineNumberPrefixes(oldText);
  if (stripped) {
    return {
      cause: 'LINE_NUMBER_PREFIX',
      hint: `oldText still contains read_file line-number prefixes ("N: "), but the stripped block does not align with line ${stripped.blockStartLine}; the file may have changed.`,
    };
  }
  if (TRUNCATION_MARKERS.some((marker) => oldText.includes(marker))) {
    return {
      cause: 'TRUNCATION_MARKER',
      hint: 'oldText contains a display truncation marker ("... [truncated N chars]" or a spill notice); those markers are not part of the source file.',
    };
  }
  if (hasBlankLineDrift(content, oldText)) {
    return {
      cause: 'BLANK_LINE_DRIFT',
      hint: 'oldText differs from the file only by blank lines; adjust the blank lines to match the current file.',
    };
  }
  if (candidates.length === 0) {
    return {
      cause: 'STALE_CONTENT',
      hint: 'No similar line exists in the current file; oldText is likely stale or from another file.',
    };
  }
  return { cause: 'UNKNOWN' };
}

function hasBlankLineDrift(content: string, oldText: string): boolean {
  const oldLines = normalizeLineEndingsWithBoundaries(oldText).text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (oldLines.length < 2) return false;
  const contentWithoutBlanks = normalizeLineEndingsWithBoundaries(content).text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
  return contentWithoutBlanks.includes(oldLines.join('\n'));
}

const MAX_SUGGESTED_EDIT_LINES = 50;
const MAX_SUGGESTED_READ_LINES = 800;

function buildSuggestedEditWindow(
  content: string,
  oldText: string,
  candidateLine: number,
): { text: string; startLine: number; endLine: number; truncated: boolean; anchorLineCount: number } | undefined {
  const lines = normalizeLineEndingsWithBoundaries(content).text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return undefined;

  const stripped = stripLineNumberPrefixes(oldText);
  const sourceLines = (stripped?.text ?? normalizeLineEndingsWithBoundaries(oldText).text).split('\n');
  if (sourceLines.length > 0 && sourceLines[sourceLines.length - 1] === '') sourceLines.pop();
  const desiredLines = Math.min(Math.max(sourceLines.length, 1), MAX_SUGGESTED_EDIT_LINES);

  const startLine = Math.min(Math.max(candidateLine, 1), lines.length);
  const endLine = Math.min(lines.length, startLine + desiredLines - 1);
  return {
    text: lines.slice(startLine - 1, endLine).join('\n'),
    startLine,
    endLine,
    truncated: endLine - startLine + 1 < sourceLines.length,
    anchorLineCount: Math.max(sourceLines.length, 1),
  };
}

function findNearbyCandidates(content: string, oldText: string): Array<{ line: number; preview: string; score: number }> {
  const anchor = normalizeLineEndingsWithBoundaries(oldText).text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || '';
  if (!anchor) return [];
  return normalizeLineEndingsWithBoundaries(content).text
    .split('\n')
    .map((line, index) => ({ line: index + 1, preview: line.trim().slice(0, 240), score: diceSimilarity(anchor, line.trim()) }))
    .filter((candidate) => candidate.score >= 0.3)
    .sort((a, b) => b.score - a.score || a.line - b.line)
    .slice(0, 3);
}

function analyzeCandidateDiff(targetText: string, candidatePreview: string): string | undefined {
  const t = targetText.trim();
  const c = candidatePreview.trim();
  if (!t || !c) return undefined;

  const hints: string[] = [];
  if (t.replace(/['"`]/g, "'") === c.replace(/['"`]/g, "'")) {
    hints.push('Mismatch due to quote style (quotes \' vs " vs `).');
  }
  if (t.replace(/\s+/g, ' ') === c.replace(/\s+/g, ' ')) {
    hints.push('Mismatch due to whitespace or leading indentation (indentation/spaces).');
  }
  if (t.replace(/[;,.\s]/g, '') === c.replace(/[;,.\s]/g, '')) {
    hints.push('Mismatch due to semicolons (;) or trailing punctuation.');
  }
  return hints.length > 0 ? hints.join(' ') : undefined;
}

function diceSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (!left || !right) return 0;
  if (left.includes(right) || right.includes(left)) return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  const pairs = (value: string) => {
    const result = new Map<string, number>();
    for (let index = 0; index < value.length - 1; index++) {
      const pair = value.slice(index, index + 2);
      result.set(pair, (result.get(pair) || 0) + 1);
    }
    return result;
  };
  const leftPairs = pairs(left);
  const rightPairs = pairs(right);
  let overlap = 0;
  for (const [pair, count] of leftPairs) overlap += Math.min(count, rightPairs.get(pair) || 0);
  return (2 * overlap) / Math.max(1, left.length + right.length - 2);
}

function detectDominantEol(content: string): '\r\n' | '\n' {
  return detectLocalEol(content) || '\n';
}

function detectLocalEol(content: string): '\r\n' | '\n' | undefined {
  const crlf = (content.match(/\r\n/g) || []).length;
  const lf = (content.match(/(?<!\r)\n/g) || []).length;
  if (crlf === 0 && lf === 0) return undefined;
  return crlf >= lf ? '\r\n' : '\n';
}

function lineNumberAt(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length;
}

function hashContent(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

function normalizeHash(hash: string): string {
  const trimmed = hash.trim().toLowerCase();
  return trimmed.startsWith('sha256:') ? trimmed.slice(7) : trimmed;
}

function isHashMatch(expected: string, observed: string): boolean {
  const normExpected = normalizeHash(expected);
  const normObserved = normalizeHash(observed);
  if (normExpected === normObserved) return true;
  if (normExpected.length >= 8 && normObserved.startsWith(normExpected)) return true;
  return false;
}
