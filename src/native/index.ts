import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

export interface NativeShellAnalysis {
  segments: string[];
  operators: string[];
  complex: boolean;
  error?: string | null;
}

export interface NativePathResult {
  success: boolean;
  resolvedPath?: string | null;
  error?: string | null;
}

export interface NativeExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface NativeHunkApplyResult {
  success: boolean;
  matchedLineIndex?: number | null;
  fuzzLevelUsed: number;
  error?: string | null;
  newContent?: string | null;
}

export interface NativeSearchMatch {
  file: string;
  lineNumber: number;
  lineContent: string;
}

export interface NativeSearchResult {
  matches: NativeSearchMatch[];
  totalScannedFiles: number;
  durationMs: number;
}

export interface NativeBatchFileReadResult {
  relPath: string;
  content?: string | null;
  hash?: string | null;
  totalLines: number;
  sizeBytes: number;
  error?: string | null;
}

export interface NativeHistoryStats {
  totalChars: number;
  totalBytes: number;
  estimatedTokens: number;
}

interface NativeCoreModule {
  rsVersion(): string;
  rsAnalyzeShellCommand(command: string): NativeShellAnalysis;
  rsResolveSafePath(rootDir: string, targetPath: string): NativePathResult;
  rsExecuteIsolated(command: string, cwd: string, timeoutMs: number, maxBytes: number): NativeExecutionResult;
  rsApplyHunk(original: string, hunkLines: string[], expectedStart: number): NativeHunkApplyResult;
  rsSearchCodebase(
    targetDir: string,
    query: string,
    isRegex: boolean,
    ignoreCase: boolean,
    maxMatches: number,
    ignoredDirs: string[]
  ): NativeSearchResult;
  rsCosineSimilarity(a: number[], b: number[]): number;
  rsCosineSimilarityTyped?(a: Float64Array, b: Float64Array): number;
  rsBatchCosineSimilarity?(query: Float64Array, database: Float64Array, dims: number): number[];
  rsGenerateSubwordEmbedding(text: string): number[];
  rsComputeFileHash(filePath: string): string;
  rsComputeStringHash(content: string): string;
  rsScanAndDigestWorkspace(rootDir: string, ignoredDirs: string[]): string;
  rsBatchReadFiles(rootDir: string, relPaths: string[], maxBytes: number): NativeBatchFileReadResult[];
  rsFastHistoryStats(payloads: string[]): NativeHistoryStats;
}

let nativeCore: NativeCoreModule | null = null;
let nativeLoadAttempted = false;

/**
 * Thử tải Native Addon biên dịch từ Rust qua NAPI-RS
 */
export function getNativeCore(): NativeCoreModule | null {
  if (nativeLoadAttempted) {
    return nativeCore;
  }
  nativeLoadAttempted = true;

  const candidatePaths = [
    // Build artifacts từ cargo / napi-build
    path.resolve(process.cwd(), 'crates/minus_core/minus_core.node'),
    path.resolve(process.cwd(), 'crates/minus_core/target/release/minus_core.node'),
    path.resolve(process.cwd(), 'crates/minus_core/target/release/minus_core.dll'),
    path.resolve(process.cwd(), 'crates/minus_core/target/debug/minus_core.node'),
    path.resolve(process.cwd(), 'crates/minus_core/target/debug/minus_core.dll'),
    path.resolve(process.cwd(), 'dist/minus_core.node'),
    path.resolve(process.cwd(), 'minus_core.node'),
  ];

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      try {
        nativeCore = require(p) as NativeCoreModule;
        return nativeCore;
      } catch {
        // Tiếp tục thử đường dẫn khác
      }
    }
  }

  return null;
}

export function isNativeAvailable(): boolean {
  return getNativeCore() !== null;
}

export function getNativeVersion(): string | null {
  const core = getNativeCore();
  return core ? core.rsVersion() : null;
}

/**
 * Quét toàn bộ thư mục và tính digest đại diện cho Workspace trong 1 lần gọi (Bulk processing)
 */
export function nativeScanAndDigestWorkspace(rootDir: string, ignoredDirs: string[]): string | null {
  const core = getNativeCore();
  if (core && typeof core.rsScanAndDigestWorkspace === 'function') {
    try {
      return core.rsScanAndDigestWorkspace(rootDir, ignoredDirs);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Đọc hàng loạt file trong workspace cùng lúc bằng Memory-Mapped I/O và kiểm tra Path Guard (Bulk read)
 */
export function nativeBatchReadFiles(
  rootDir: string,
  relPaths: string[],
  maxBytes: number = 200 * 1024,
): NativeBatchFileReadResult[] | null {
  const core = getNativeCore();
  if (core && typeof core.rsBatchReadFiles === 'function') {
    try {
      return core.rsBatchReadFiles(rootDir, relPaths, maxBytes);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Phân tích thống kê ký tự và ước lượng token của toàn bộ session trong 1 lần gọi (Bulk history stats)
 */
export function nativeFastHistoryStats(payloads: string[]): NativeHistoryStats {
  const core = getNativeCore();
  if (core && typeof core.rsFastHistoryStats === 'function') {
    try {
      return core.rsFastHistoryStats(payloads);
    } catch {
      // Fallback
    }
  }

  // TypeScript Fallback (Zero crash guarantee)
  let totalChars = 0;
  let totalBytes = 0;
  for (const p of payloads) {
    totalBytes += Buffer.byteLength(p, 'utf8');
    totalChars += p.length;
  }
  return {
    totalChars,
    totalBytes,
    estimatedTokens: Math.ceil(totalChars / 3.8),
  };
}
