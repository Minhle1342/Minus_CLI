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
  isSandboxed?: boolean;
}

export interface NativeVfsFileStatus {
  path: string;
  status: 'created' | 'modified' | 'deleted' | string;
  sizeBytes: number;
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
  rsExecuteSandboxed?(command: string, cwd: string, timeoutMs: number, maxBytes: number, memoryLimitMb: number): NativeExecutionResult;
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
  rsVfsCreateSession?(sessionId: string, rootDir: string): boolean;
  rsVfsReadFile?(sessionId: string, relPath: string): string | null;
  rsVfsWriteFile?(sessionId: string, relPath: string, content: string): boolean;
  rsVfsDeleteFile?(sessionId: string, relPath: string): boolean;
  rsVfsListModified?(sessionId: string): NativeVfsFileStatus[];
  rsVfsGenerateDiff?(sessionId: string): string;
  rsVfsCommitToDisk?(sessionId: string): string[];
  rsVfsDestroySession?(sessionId: string): boolean;
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

/**
 * Thuật toán băm FNV-1a 32-bit khớp với vector memory & minus_core
 */
function fnv1a32(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h;
}

/**
 * Fallback thuần TypeScript tính subword embedding vector 384 chiều và Cosine Similarity
 */
function fallbackSemanticSimilarity(textA: string, textB: string): number {
  const dims = 384;
  const embed = (text: string): Float64Array => {
    const vec = new Float64Array(dims);
    const normalized = text.trim().toLowerCase();
    const words = normalized.split(/[^a-z0-9_#$@.-]+/).filter(Boolean);
    for (const w of words) {
      const wh = fnv1a32(w);
      const idx1 = Math.abs(wh) % dims;
      const sign1 = (wh % 2 === 0) ? 1.0 : -1.0;
      vec[idx1] += 2.0 * sign1;

      // Character tri-grams
      if (w.length >= 3) {
        for (let i = 0; i <= w.length - 3; i++) {
          const tri = w.slice(i, i + 3);
          const th = fnv1a32(tri);
          const idx2 = Math.abs(th) % dims;
          const sign2 = (th % 2 === 0) ? 0.5 : -0.5;
          vec[idx2] += sign2;
        }
      }
    }
    return vec;
  };

  const vA = embed(textA);
  const vB = embed(textB);

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < dims; i++) {
    dot += vA[i] * vB[i];
    normA += vA[i] * vA[i];
    normB += vB[i] * vB[i];
  }

  if (normA === 0 || normB === 0) return 0.0;
  const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Number.isFinite(sim) ? Math.max(0, Math.min(1, sim)) : 0.0;
}

const DOMAIN_CONCEPT_SYNONYMS: Array<[RegExp, string]> = [
  [/\b(auth|authenticat\w*|jwt|bearer|tokens?|oauth|credentials?|login)\b/i, 'auth_domain token_concept'],
  [/\b(fix\w*|resolv\w*|patch\w*|repair\w*|solv\w*|debug\w*)\b/i, 'repair_action'],
  [/\b(bugs?|issues?|errors?|faults?|defects?|failures?|crashes?)\b/i, 'defect_concept'],
  [/\b(expir\w*|timeouts?|stale|ttl)\b/i, 'expiry_concept'],
  [/\b(optimiz\w*|perf\w*|latenc\w*|throughput|speed\w*|fast)\b/i, 'perf_domain'],
  [/\b(tests?|verif\w*|specs?|validat\w*|assertions?)\b/i, 'testing_domain'],
  [/\b(refactor\w*|restructur\w*|clean\w*|moderniz\w*)\b/i, 'refactor_action'],
  [/\b(dbs?|databases?|sql|postgres|sqlite|migrations?)\b/i, 'database_domain'],
  [/\b(uis?|frontends?|views?|components?|styles?|css)\b/i, 'ui_domain'],
];

function expandCanonicalConcepts(text: string): string {
  let expanded = text.toLowerCase();
  for (const [pattern, canonical] of DOMAIN_CONCEPT_SYNONYMS) {
    if (pattern.test(expanded)) {
      expanded += ' ' + canonical;
    }
  }
  return expanded;
}

/**
 * Tính toán độ tương đồng ngữ nghĩa siêu tốc giữa 2 câu mục tiêu / nhiệm vụ
 * Sử dụng Rust Native Core (SIMD Cosine + Subword Embedding) nếu khả dụng, fallback sang pure TypeScript nếu không.
 */
export function nativeComputeSemanticSimilarity(textA: string, textB: string): number {
  const normA = textA.trim().toLowerCase();
  const normB = textB.trim().toLowerCase();
  if (!normA || !normB) return 0.0;
  if (normA === normB) return 1.0;

  const expandedA = expandCanonicalConcepts(normA);
  const expandedB = expandCanonicalConcepts(normB);

  const core = getNativeCore();
  if (core && typeof core.rsGenerateSubwordEmbedding === 'function' && typeof core.rsCosineSimilarity === 'function') {
    try {
      const vecA = core.rsGenerateSubwordEmbedding(expandedA);
      const vecB = core.rsGenerateSubwordEmbedding(expandedB);
      const sim = core.rsCosineSimilarity(vecA, vecB);
      if (Number.isFinite(sim)) {
        return Math.max(0, Math.min(1, sim));
      }
    } catch {
      // Fallback sang TS
    }
  }

  return fallbackSemanticSimilarity(expandedA, expandedB);
}

/**
 * Thực thi lệnh trong Sandbox cứng cấp kernel (Windows Job Objects / Resource Quota)
 * Giới hạn bộ nhớ tối đa và đảm bảo diệt sạch 100% cây tiến trình con khi timeout.
 */
export function nativeExecuteSandboxed(
  command: string,
  cwd: string,
  timeoutMs: number = 30000,
  maxBytes: number = 5 * 1024 * 1024,
  memoryLimitMb: number = 2048,
): NativeExecutionResult | null {
  const core = getNativeCore();
  if (core) {
    if (typeof core.rsExecuteSandboxed === 'function') {
      try {
        return core.rsExecuteSandboxed(command, cwd, timeoutMs, maxBytes, memoryLimitMb);
      } catch {
        // fallback
      }
    }
    if (typeof core.rsExecuteIsolated === 'function') {
      try {
        return core.rsExecuteIsolated(command, cwd, timeoutMs, maxBytes);
      } catch {
        // fallback
      }
    }
  }
  return null;
}

// ── Virtual Copy-on-Write (CoW) Workspace Management ────────────────────────

interface TsVfsSession {
  rootDir: string;
  overlay: Map<string, { content?: string; deleted?: boolean }>;
}

const tsVfsSessions = new Map<string, TsVfsSession>();

/**
 * Khởi tạo một phiên Virtual Workspace độc lập trong RAM (Zero-cost branching)
 */
export function nativeVfsCreateSession(sessionId: string, rootDir: string): boolean {
  const core = getNativeCore();
  if (core && typeof core.rsVfsCreateSession === 'function') {
    try {
      return core.rsVfsCreateSession(sessionId, rootDir);
    } catch {}
  }
  tsVfsSessions.set(sessionId, { rootDir, overlay: new Map() });
  return true;
}

/**
 * Đọc file từ Virtual Workspace: Trả về dữ liệu RAM overlay nếu đã sửa, hoặc đọc disk base nếu chưa.
 */
export function nativeVfsReadFile(sessionId: string, relPath: string): string | null {
  const core = getNativeCore();
  if (core && typeof core.rsVfsReadFile === 'function') {
    try {
      const res = core.rsVfsReadFile(sessionId, relPath);
      if (res !== undefined) return res;
    } catch {}
  }
  const session = tsVfsSessions.get(sessionId);
  if (!session) return null;
  const norm = relPath.replace(/\\/g, '/').replace(/^\//, '');
  const entry = session.overlay.get(norm);
  if (entry) {
    return entry.deleted ? null : (entry.content ?? null);
  }
  const full = path.join(session.rootDir, norm);
  try {
    return fs.readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Ghi file trực tiếp vào RAM overlay của Virtual Workspace với độ trễ O(1) < 1µs
 */
export function nativeVfsWriteFile(sessionId: string, relPath: string, content: string): boolean {
  const core = getNativeCore();
  if (core && typeof core.rsVfsWriteFile === 'function') {
    try {
      return core.rsVfsWriteFile(sessionId, relPath, content);
    } catch {}
  }
  const session = tsVfsSessions.get(sessionId);
  if (!session) return false;
  const norm = relPath.replace(/\\/g, '/').replace(/^\//, '');
  session.overlay.set(norm, { content, deleted: false });
  return true;
}

/**
 * Đánh dấu xóa file trong Virtual Workspace
 */
export function nativeVfsDeleteFile(sessionId: string, relPath: string): boolean {
  const core = getNativeCore();
  if (core && typeof core.rsVfsDeleteFile === 'function') {
    try {
      return core.rsVfsDeleteFile(sessionId, relPath);
    } catch {}
  }
  const session = tsVfsSessions.get(sessionId);
  if (!session) return false;
  const norm = relPath.replace(/\\/g, '/').replace(/^\//, '');
  session.overlay.set(norm, { deleted: true });
  return true;
}

/**
 * Liệt kê danh sách các file đang bị sửa đổi (dirty) trong Virtual Workspace
 */
export function nativeVfsListModified(sessionId: string): NativeVfsFileStatus[] {
  const core = getNativeCore();
  if (core && typeof core.rsVfsListModified === 'function') {
    try {
      return core.rsVfsListModified(sessionId);
    } catch {}
  }
  const session = tsVfsSessions.get(sessionId);
  if (!session) return [];
  const list: NativeVfsFileStatus[] = [];
  for (const [p, state] of session.overlay.entries()) {
    list.push({
      path: p,
      status: state.deleted ? 'deleted' : 'modified',
      sizeBytes: state.content ? Buffer.byteLength(state.content, 'utf8') : 0,
    });
  }
  return list;
}

/**
 * Sinh diff thống nhất (Unified diff) từ các thay đổi ảo trong RAM
 */
export function nativeVfsGenerateDiff(sessionId: string): string {
  const core = getNativeCore();
  if (core && typeof core.rsVfsGenerateDiff === 'function') {
    try {
      return core.rsVfsGenerateDiff(sessionId);
    } catch {}
  }
  const session = tsVfsSessions.get(sessionId);
  if (!session) return '';
  let diff = '';
  for (const [p, state] of session.overlay.entries()) {
    diff += `diff --git a/${p} b/${p}\n`;
    if (state.deleted) {
      diff += `deleted file mode 100644\n--- a/${p}\n+++ /dev/null\n`;
    } else {
      diff += `--- a/${p}\n+++ b/${p}\n`;
      for (const line of (state.content || '').split('\n')) {
        diff += `+${line}\n`;
      }
    }
  }
  return diff;
}

/**
 * Ghi các file dirty từ RAM xuống đĩa vật lý chỉ khi Quality Gate thông qua
 */
export function nativeVfsCommitToDisk(sessionId: string): string[] {
  const core = getNativeCore();
  if (core && typeof core.rsVfsCommitToDisk === 'function') {
    try {
      return core.rsVfsCommitToDisk(sessionId);
    } catch {}
  }
  const session = tsVfsSessions.get(sessionId);
  if (!session) return [];
  const committed: string[] = [];
  for (const [p, state] of session.overlay.entries()) {
    const full = path.join(session.rootDir, p);
    if (state.deleted) {
      if (fs.existsSync(full)) fs.unlinkSync(full);
      committed.push(p);
    } else if (state.content !== undefined) {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, state.content, 'utf8');
      committed.push(p);
    }
  }
  session.overlay.clear();
  return committed;
}

/**
 * Hủy bỏ phiên Virtual Workspace và giải phóng bộ đệm RAM ngay lập tức
 */
export function nativeVfsDestroySession(sessionId: string): boolean {
  const core = getNativeCore();
  if (core && typeof core.rsVfsDestroySession === 'function') {
    try {
      return core.rsVfsDestroySession(sessionId);
    } catch {}
  }
  return tsVfsSessions.delete(sessionId);
}
