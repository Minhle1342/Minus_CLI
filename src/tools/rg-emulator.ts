import fs from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../workspace/workspace.js';

export interface RgParsedOptions {
  query: string;
  isRegex: boolean;
  ignoreCase: boolean;
  invertMatch: boolean;
  wordRegexp: boolean;
  filesWithMatchesOnly: boolean;
  countOnly: boolean;
  showLineNumbers: boolean;
  maxCountPerFile?: number;
  maxTotalMatches?: number;
  contextBefore?: number;
  contextAfter?: number;
  globFilter?: string[];
  typeFilter?: string[];
  targetPaths: string[];
}

/**
 * Phân tích dòng lệnh rg / ripgrep / grep thành các tham số cấu hình tìm kiếm
 */
export function parseRipgrepCommand(command: string): RgParsedOptions | null {
  const trimmed = command.trim();
  if (!/^(?:rg|ripgrep|grep|ag)\b/i.test(trimmed)) {
    return null;
  }

  // Tách tokens theo quy tắc shell (bảo toàn chuỗi trong nháy đơn và nháy kép)
  const tokenRegex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  const tokens: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(trimmed)) !== null) {
    if (match[1] !== undefined) {
      tokens.push(match[1].replace(/\\"/g, '"'));
    } else if (match[2] !== undefined) {
      tokens.push(match[2].replace(/\\'/g, "'"));
    } else if (match[3] !== undefined) {
      tokens.push(match[3]);
    }
  }

  if (tokens.length < 2) {
    return null;
  }

  // Bỏ token đầu tiên (rg / grep)
  const args = tokens.slice(1);

  let query: string | null = null;
  let isRegex = true;
  let ignoreCase = false;
  let invertMatch = false;
  let wordRegexp = false;
  let filesWithMatchesOnly = false;
  let countOnly = false;
  let showLineNumbers = true;
  let maxCountPerFile: number | undefined;
  let maxTotalMatches: number | undefined;
  let contextBefore: number | undefined;
  let contextAfter: number | undefined;
  const globFilter: string[] = [];
  const typeFilter: string[] = [];
  const targetPaths: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '-i' || arg === '--ignore-case') {
      ignoreCase = true;
    } else if (arg === '-S' || arg === '--smart-case') {
      ignoreCase = true; // Sẽ tự điều chỉnh nếu query có chữ hoa
    } else if (arg === '-s' || arg === '--case-sensitive') {
      ignoreCase = false;
    } else if (arg === '-F' || arg === '--fixed-strings' || arg === '-Q') {
      isRegex = false;
    } else if (arg === '-v' || arg === '--invert-match') {
      invertMatch = true;
    } else if (arg === '-w' || arg === '--word-regexp') {
      wordRegexp = true;
    } else if (arg === '-l' || arg === '--files-with-matches') {
      filesWithMatchesOnly = true;
    } else if (arg === '-c' || arg === '--count') {
      countOnly = true;
    } else if (arg === '-n' || arg === '--line-number') {
      showLineNumbers = true;
    } else if (arg === '-N' || arg === '--no-line-number') {
      showLineNumbers = false;
    } else if (arg === '-m' || arg === '--max-count') {
      i++;
      const val = parseInt(args[i], 10);
      if (!isNaN(val) && val > 0) maxCountPerFile = val;
    } else if (arg.startsWith('-m=')) {
      const val = parseInt(arg.slice(3), 10);
      if (!isNaN(val) && val > 0) maxCountPerFile = val;
    } else if (arg === '-C' || arg === '--context') {
      i++;
      const val = parseInt(args[i], 10);
      if (!isNaN(val) && val >= 0) {
        contextBefore = val;
        contextAfter = val;
      }
    } else if (arg === '-B' || arg === '--before-context') {
      i++;
      const val = parseInt(args[i], 10);
      if (!isNaN(val) && val >= 0) contextBefore = val;
    } else if (arg === '-A' || arg === '--after-context') {
      i++;
      const val = parseInt(args[i], 10);
      if (!isNaN(val) && val >= 0) contextAfter = val;
    } else if (arg === '-g' || arg === '--glob') {
      i++;
      if (args[i]) globFilter.push(args[i]);
    } else if (arg === '-t' || arg === '--type') {
      i++;
      if (args[i]) typeFilter.push(args[i]);
    } else if (arg === '-e' || arg === '--regexp') {
      i++;
      if (args[i]) query = args[i];
    } else if (arg === '-r' || arg === '-R' || arg === '--recursive') {
      // Grep recursive flag - mặc định rg đã recursive
    } else if (arg === '--' || arg === '-') {
      // End of options
    } else if (arg.startsWith('-')) {
      // Bỏ qua các flag khác (như --color, -H, --no-heading, v.v.)
    } else {
      // Vị trí positional
      if (query === null) {
        query = arg;
      } else {
        targetPaths.push(arg);
      }
    }
    i++;
  }

  if (query === null) {
    return null;
  }

  if (targetPaths.length === 0) {
    targetPaths.push('.');
  }

  return {
    query,
    isRegex,
    ignoreCase,
    invertMatch,
    wordRegexp,
    filesWithMatchesOnly,
    countOnly,
    showLineNumbers,
    maxCountPerFile,
    maxTotalMatches: 200,
    contextBefore,
    contextAfter,
    globFilter: globFilter.length > 0 ? globFilter : undefined,
    typeFilter: typeFilter.length > 0 ? typeFilter : undefined,
    targetPaths,
  };
}

/**
 * Trình giả lập ripgrep (rg) và grep thuần TypeScript / Node.js
 * Chạy trực tiếp trên Workspace, không cần binary ngoài, không phát sinh lỗi 127
 */
export async function executeRipgrepEmulation(
  commandOrOptions: string | RgParsedOptions,
  workspace: Workspace
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  success: boolean;
  matchCount: number;
}> {
  const startTime = Date.now();
  const options = typeof commandOrOptions === 'string'
    ? parseRipgrepCommand(commandOrOptions)
    : commandOrOptions;

  if (!options || !options.query) {
    return {
      stdout: '',
      stderr: 'ripgrep-emulator: invalid or empty search query',
      exitCode: 2,
      durationMs: Date.now() - startTime,
      success: false,
      matchCount: 0,
    };
  }

  let regex: RegExp;
  try {
    let pattern = options.query;
    if (!options.isRegex) {
      pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    if (options.wordRegexp) {
      pattern = `\\b(?:${pattern})\\b`;
    }
    const flags = options.ignoreCase ? 'gi' : 'g';
    regex = new RegExp(pattern, flags);
  } catch (err: any) {
    return {
      stdout: '',
      stderr: `ripgrep-emulator regex error: ${err.message}`,
      exitCode: 2,
      durationMs: Date.now() - startTime,
      success: false,
      matchCount: 0,
    };
  }

  const outputLines: string[] = [];
  let totalMatches = 0;
  const maxLimit = options.maxTotalMatches || 200;

  // Thu thập danh sách files cần tìm kiếm
  const targetFiles: string[] = [];

  for (const rawTarget of options.targetPaths) {
    try {
      const safePath = workspace.resolveSafePath(rawTarget);
      const stat = await fs.stat(safePath);

      if (stat.isFile()) {
        targetFiles.push(safePath);
      } else if (stat.isDirectory()) {
        await collectFiles(safePath, targetFiles, workspace, options);
      }
    } catch {
      // Bỏ qua đường dẫn không tồn tại
    }
  }

  for (const filePath of targetFiles) {
    if (totalMatches >= maxLimit) break;

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split(/\r?\n/);
      const relPath = workspace.toRelativePath(filePath).replace(/\\/g, '/');

      let fileMatchCount = 0;
      const matchingLineIndices: number[] = [];

      for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx];
        regex.lastIndex = 0;
        const isMatched = regex.test(line);
        const effectiveMatch = options.invertMatch ? !isMatched : isMatched;

        if (effectiveMatch) {
          fileMatchCount++;
          matchingLineIndices.push(idx);
          if (options.maxCountPerFile && fileMatchCount >= options.maxCountPerFile) {
            break;
          }
        }
      }

      if (fileMatchCount > 0) {
        totalMatches += fileMatchCount;

        if (options.filesWithMatchesOnly) {
          outputLines.push(relPath);
        } else if (options.countOnly) {
          outputLines.push(`${relPath}:${fileMatchCount}`);
        } else {
          for (const lineIdx of matchingLineIndices) {
            const lineNum = lineIdx + 1;
            const lineContent = lines[lineIdx];
            if (options.showLineNumbers) {
              outputLines.push(`${relPath}:${lineNum}:${lineContent}`);
            } else {
              outputLines.push(`${relPath}:${lineContent}`);
            }
          }
        }
      }
    } catch {
      // Bỏ qua file nhị phân hoặc không đọc được
    }
  }

  const durationMs = Date.now() - startTime;
  const stdout = outputLines.join('\n');
  const exitCode = totalMatches > 0 ? 0 : 1;

  return {
    stdout,
    stderr: '',
    exitCode,
    durationMs,
    success: totalMatches > 0,
    matchCount: totalMatches,
  };
}

/**
 * Đệ quy thu thập file trong thư mục
 */
async function collectFiles(
  dirPath: string,
  outFiles: string[],
  workspace: Workspace,
  options: RgParsedOptions
): Promise<void> {
  if (outFiles.length >= 2000) return;

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (outFiles.length >= 2000) break;

      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        if (workspace.isIgnoredDirectory(entry.name)) {
          continue;
        }
        await collectFiles(fullPath, outFiles, workspace, options);
      } else if (entry.isFile()) {
        if (workspace.isBinaryFile(entry.name)) {
          continue;
        }

        // Kiểm tra lọc type (ví dụ: ts, js, py)
        if (options.typeFilter && options.typeFilter.length > 0) {
          const ext = path.extname(entry.name).replace(/^\./, '').toLowerCase();
          if (!options.typeFilter.includes(ext)) {
            continue;
          }
        }

        // Kiểm tra glob đơn giản
        if (options.globFilter && options.globFilter.length > 0) {
          const matchedGlob = options.globFilter.some((glob) => {
            if (glob.startsWith('*.')) {
              const targetExt = glob.slice(1);
              return entry.name.endsWith(targetExt);
            }
            return entry.name.includes(glob.replace(/\*/g, ''));
          });
          if (!matchedGlob) continue;
        }

        outFiles.push(fullPath);
      }
    }
  } catch {}
}
