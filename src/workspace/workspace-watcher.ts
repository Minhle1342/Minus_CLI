import fs from 'node:fs';
import path from 'node:path';
import type { Workspace } from './workspace.js';

export type FileChangeKind = 'create' | 'modify' | 'delete' | 'rename';

export interface FileChangeEvent {
  relPath: string;
  kind: FileChangeKind;
  mtimeMs?: number;
  external: boolean;
}

export interface WatcherOptions {
  debounceMs?: number;
  ownWriteWindowMs?: number;
  maxBatch?: number;
}

function isTestLikeEnv(): boolean {
  if (process.env.VITEST === 'true' || process.env.VITEST_WORKER_ID !== undefined) return true;
  const nodeEnv = (process.env.NODE_ENV || '').toLowerCase();
  if (nodeEnv === 'test' || nodeEnv === 'ci') return true;
  if (process.env.CI === 'true' || process.env.CI === '1') return true;
  if (process.env.MINUS_EVAL_RUN === '1') return true;
  return false;
}

/**
 * Hybrid gate: PR1 default OFF everywhere. Enable explicitly with
 * MINUS_WATCHER=1 or --watch. Forced OFF in test/eval/CI.
 */
export function isWatcherEnabled(argv: string[] = process.argv): boolean {
  if (isTestLikeEnv()) return false;
  if (process.env.MINUS_WATCHER === '0' || process.env.MINUS_WATCHER === 'off') return false;
  if (process.env.MINUS_WATCHER === '1' || process.env.MINUS_WATCHER === 'on') return true;
  if (argv.includes('--watch') || argv.includes('--watcher')) return true;
  return false;
}

function normalizeRel(rootDir: string, absPath: string): string {
  return path.relative(rootDir, absPath).replace(/\\/g, '/');
}

function isIgnoredRel(rel: string, workspace: Workspace): boolean {
  if (!rel || rel.startsWith('..')) return true;
  const segments = rel.split('/');
  for (const seg of segments) {
    if (!seg) continue;
    if (seg === '.git' || seg.startsWith('.minus') || seg.startsWith('.codingagent')) return true;
    if (workspace.isIgnoredDirectory(seg)) return true;
  }
  const base = segments[segments.length - 1] || '';
  if (workspace.isBinaryFile(base)) return true;
  if (base.endsWith('.node') || base.endsWith('.log')) return true;
  return false;
}

/**
 * Opt-in realtime workspace watcher (PR1: TS-only, zero-dep).
 * Uses node:fs.watch recursive where available, falls back to
 * manifest polling on Linux. Rust fast paths (rsScanAndDigest,
 * rsComputeFileHash) remain the preflight source of truth;
 * this class only delivers early external-change hints.
 */
export class WorkspaceWatcher {
  private workspace: Workspace;
  private rootDir: string;
  private opts: Required<WatcherOptions>;
  private listeners = new Set<(events: FileChangeEvent[]) => void>();
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pending = new Map<string, FileChangeEvent>();
  private ownWrites = new Map<string, number>();
  private lastManifest = new Map<string, string>();
  private running = false;

  constructor(workspace: Workspace, opts: WatcherOptions = {}) {
    this.workspace = workspace;
    this.rootDir = path.resolve(workspace.rootDir);
    this.opts = {
      debounceMs: opts.debounceMs ?? 150,
      ownWriteWindowMs: opts.ownWriteWindowMs ?? 500,
      maxBatch: opts.maxBatch ?? 50,
    };
  }

  /** Mark paths written by the agent itself so they are not reported as external. */
  markOwnWrite(relPath: string): void {
    const norm = relPath.replace(/\\/g, '/').replace(/^\//, '');
    this.ownWrites.set(norm, Date.now());
  }

  markOwnWrites(relPaths: string[]): void {
    for (const p of relPaths) this.markOwnWrite(p);
  }

  onChange(cb: (events: FileChangeEvent[]) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    try {
      this.watcher = fs.watch(this.rootDir, { recursive: true } as any, (eventType, filename) => {
        if (typeof filename !== 'string' || !filename) return;
        this.ingestRaw(filename, eventType);
      });
      this.watcher.on('error', () => {
        this.startPollingFallback();
      });
    } catch {
      this.startPollingFallback();
    }
    if (process.platform === 'linux') {
      this.startPollingFallback();
    }
  }

  stop(): void {
    this.running = false;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.debounceTimer = null;
    this.pollTimer = null;
    try {
      this.watcher?.close();
    } catch {
      // ignore close errors during teardown
    }
    this.watcher = null;
    this.pending.clear();
  }

  getPendingExternalChanges(): FileChangeEvent[] {
    return [...this.pending.values()].filter((e) => e.external).slice(0, this.opts.maxBatch);
  }

  clear(): void {
    this.pending.clear();
  }

  private ingestRaw(filename: string, eventType: string): void {
    const rel = normalizeRel(this.rootDir, path.resolve(this.rootDir, filename));
    if (isIgnoredRel(rel, this.workspace)) return;
    const now = Date.now();
    const ownAt = this.ownWrites.get(rel);
    const external = !(ownAt !== undefined && now - ownAt <= this.opts.ownWriteWindowMs);
    let kind: FileChangeKind = eventType === 'rename' ? 'rename' : 'modify';
    try {
      const st = fs.statSync(path.join(this.rootDir, rel));
      kind = eventType === 'rename' ? 'create' : 'modify';
      this.pending.set(rel, { relPath: rel, kind, mtimeMs: st.mtimeMs, external });
    } catch {
      this.pending.set(rel, { relPath: rel, kind: 'delete', external });
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flush(), this.opts.debounceMs);
  }

  private flush(): void {
    if (this.pending.size === 0) return;
    const batch = [...this.pending.values()].slice(0, this.opts.maxBatch);
    this.pending.clear();
    for (const cb of [...this.listeners]) {
      try {
        cb(batch);
      } catch {
        // listener errors must not break the watcher
      }
    }
  }

  private startPollingFallback(): void {
    if (this.pollTimer) return;
    void this.snapshotManifest();
    this.pollTimer = setInterval(() => {
      void this.snapshotManifest().catch(() => {});
    }, 2500);
    this.pollTimer.unref?.();
  }

  private async snapshotManifest(): Promise<void> {
    const current = await collectSizeMtimeManifest(this.rootDir, this.workspace);
    if (this.lastManifest.size === 0) {
      this.lastManifest = current;
      return;
    }
    for (const [rel, fp] of current) {
      if (isIgnoredRel(rel, this.workspace)) continue;
      if (this.lastManifest.get(rel) !== fp) {
        const now = Date.now();
        const ownAt = this.ownWrites.get(rel);
        const external = !(ownAt !== undefined && now - ownAt <= this.opts.ownWriteWindowMs);
        this.pending.set(rel, { relPath: rel, kind: this.lastManifest.has(rel) ? 'modify' : 'create', external });
      }
    }
    for (const rel of this.lastManifest.keys()) {
      if (!current.has(rel) && !isIgnoredRel(rel, this.workspace)) {
        this.pending.set(rel, { relPath: rel, kind: 'delete', external: true });
      }
    }
    this.lastManifest = current;
    if (this.pending.size > 0) this.scheduleFlush();
  }
}

async function collectSizeMtimeManifest(
  rootDir: string,
  workspace: Workspace,
): Promise<Map<string, string>> {
  const manifest = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env') {
        if (workspace.isIgnoredDirectory(entry.name)) continue;
        if (entry.name === '.git') continue;
      }
      if (entry.isDirectory()) {
        if (workspace.isIgnoredDirectory(entry.name)) continue;
        await walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const full = path.join(dir, entry.name);
      const rel = normalizeRel(rootDir, full);
      if (isIgnoredRel(rel, workspace)) continue;
      try {
        const st = await fs.promises.stat(full);
        if (st.size > 500 * 1024) continue;
        manifest.set(rel, `${st.size}:${Math.round(st.mtimeMs)}`);
      } catch {
        // unreadable file: skip
      }
    }
  }
  await walk(rootDir);
  return manifest;
}

/**
 * Format a compact pre-step note for Session injection.
 * Callers decide whether to append it as a system note.
 */
export function formatExternalChangeNote(events: FileChangeEvent[]): string {
  const externals = events.filter((e) => e.external).slice(0, 10);
  if (externals.length === 0) return '';
  const list = externals.map((e) => `${e.kind}:${e.relPath}`).join(', ');
  const more = events.length > externals.length ? ` (+${events.length - externals.length} more)` : '';
  return `[EXTERNAL CHANGE] ${list}${more}. Re-read with read_file before editing; expectedFileHash may be stale.`;
}
