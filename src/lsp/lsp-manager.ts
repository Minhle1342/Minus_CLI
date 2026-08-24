import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Workspace } from '../workspace/workspace.js';
import { loadLspConfig } from './config.js';
import { LspClient } from './lsp-client.js';
import type {
  LspOperation,
  LspPosition,
  LspRuntimeConfig,
  LspServerConfig,
  LspServerStatus,
  NormalizedLspDiagnostic,
} from './types.js';

interface BrokenServer {
  until: number;
  detail: string;
}

export interface LspDiagnosticsResult {
  available: boolean;
  diagnostics: NormalizedLspDiagnostic[];
  providers: string[];
  status: LspServerStatus[];
  warnings: string[];
}

export class LspManager {
  readonly config: LspRuntimeConfig;
  private clients = new Map<string, LspClient>();
  private spawning = new Map<string, Promise<LspClient | undefined>>();
  private broken = new Map<string, BrokenServer>();

  constructor(readonly workspace: Workspace, config?: LspRuntimeConfig) {
    this.config = config || loadLspConfig(workspace);
  }

  async diagnostics(filePath?: string, options?: { sync?: boolean; wait?: boolean }): Promise<LspDiagnosticsResult> {
    const providers = new Set<string>();
    const diagnostics: NormalizedLspDiagnostic[] = [];
    const clients = filePath
      ? await this.clientsForFile(this.workspace.resolveSafePath(filePath))
      : [...this.clients.values()];
    for (const client of clients) {
      providers.add(client.server.id);
      const absolute = filePath ? this.workspace.resolveSafePath(filePath) : undefined;
      if (absolute && options?.sync !== false) {
        await client.syncDocument(absolute, options?.wait ? this.config.diagnosticsWaitMs : 0).catch(() => []);
      }
      for (const [target, items] of client.getDiagnostics(absolute)) {
        if (!this.isInsideWorkspace(target)) continue;
        diagnostics.push(...items.slice(0, this.config.maxDiagnosticsPerFile).map((item) => normalizeDiagnostic(
          this.workspace.toRelativePath(target),
          item,
          client.server.id,
        )));
      }
    }
    return {
      available: clients.length > 0,
      diagnostics: dedupeDiagnostics(diagnostics),
      providers: [...providers],
      status: this.status(),
      warnings: [...this.config.warnings],
    };
  }

  async query(input: {
    operation: LspOperation;
    filePath: string;
    position?: LspPosition;
    query?: string;
  }): Promise<{ available: boolean; providers: string[]; results: any[]; status: LspServerStatus[]; warnings: string[] }> {
    const absolute = this.workspace.resolveSafePath(input.filePath);
    const clients = await this.clientsForFile(absolute);
    const results: any[] = [];
    const providers: string[] = [];
    for (const client of clients) {
      try {
        const items = await client.query(
          input.operation,
          absolute,
          input.position || { line: 0, character: 0 },
          input.query || '',
        );
        providers.push(client.server.id);
        results.push(...items.map((item) => {
          const normalized = normalizeUris(item, this.workspace);
          return normalized && typeof normalized === 'object' && !Array.isArray(normalized)
            ? { provider: client.server.id, ...normalized }
            : { provider: client.server.id, value: normalized };
        }));
      } catch (error: any) {
        results.push({ provider: client.server.id, error: error.message });
      }
    }
    return { available: clients.length > 0, providers, results, status: this.status(), warnings: [...this.config.warnings] };
  }

  async mutationFeedback(filePaths: string[]): Promise<LspDiagnosticsResult> {
    const unique = [...new Set(filePaths.map((item) => item.trim()).filter(Boolean))].slice(0, 5);
    const combined: NormalizedLspDiagnostic[] = [];
    const providers = new Set<string>();
    let available = false;
    const results = await Promise.all(unique.map(async (filePath) => {
      try { return await this.diagnostics(filePath, { sync: true, wait: true }); }
      catch { return undefined; }
    }));
    for (const result of results) {
      if (result) {
        available ||= result.available;
        for (const provider of result.providers) providers.add(provider);
        combined.push(...result.diagnostics);
      }
    }
    return {
      available,
      diagnostics: dedupeDiagnostics(combined).slice(0, this.config.maxDiagnosticsPerFile),
      providers: [...providers],
      status: this.status(),
      warnings: [...this.config.warnings],
    };
  }

  status(): LspServerStatus[] {
    const result: LspServerStatus[] = [];
    for (const [key, client] of this.clients) {
      result.push({ id: client.server.id, root: this.workspace.toRelativePath(client.root) || '.', status: 'connected' });
    }
    for (const key of this.spawning.keys()) {
      const [id, root] = splitKey(key);
      result.push({ id, root: this.workspace.toRelativePath(root) || '.', status: 'starting' });
    }
    for (const [key, failure] of this.broken) {
      if (failure.until <= Date.now()) continue;
      const [id, root] = splitKey(key);
      result.push({ id, root: this.workspace.toRelativePath(root) || '.', status: 'broken', detail: failure.detail });
    }
    return result;
  }

  async shutdown(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.spawning.clear();
    await Promise.all(clients.map((client) => client.shutdown().catch(() => {})));
  }

  private async clientsForFile(filePath: string): Promise<LspClient[]> {
    if (!this.config.enabled || !this.isInsideWorkspace(filePath)) return [];
    const extension = path.extname(filePath).toLowerCase();
    const matches = this.config.servers.filter((server) => server.extensions.includes(extension));
    const clients = await Promise.all(matches.map(async (server) => {
      const root = this.findRoot(filePath, server);
      return this.getOrStartClient(server, root);
    }));
    return clients.filter((client): client is LspClient => Boolean(client));
  }

  private findRoot(filePath: string, server: LspServerConfig): string {
    if (server.rootMarkers.length === 0) return this.workspace.rootDir;
    let current = path.dirname(filePath);
    while (this.isInsideWorkspace(current)) {
      if (server.rootMarkers.some((marker) => fs.existsSync(path.join(current, marker)))) return current;
      if (samePath(current, this.workspace.rootDir)) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return this.workspace.rootDir;
  }

  private async getOrStartClient(server: LspServerConfig, root: string): Promise<LspClient | undefined> {
    const key = makeKey(server.id, root);
    const existing = this.clients.get(key);
    if (existing) return existing;
    const failure = this.broken.get(key);
    if (failure && failure.until > Date.now()) return undefined;
    if (failure) this.broken.delete(key);
    const pending = this.spawning.get(key);
    if (pending) return pending;

    const start = this.startClient(server, root, key);
    this.spawning.set(key, start);
    try {
      return await start;
    } finally {
      this.spawning.delete(key);
    }
  }

  private async startClient(server: LspServerConfig, root: string, key: string): Promise<LspClient | undefined> {
    let stderr = '';
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      const invocation = resolveLspSpawnInvocation(server.command);
      child = spawn(invocation.file, invocation.args, {
        cwd: root,
        env: { ...process.env, ...server.env },
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stderr.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-2_000); });
      const client = new LspClient(server, root, this.workspace.rootDir, child, this.config.requestTimeoutMs);
      await client.initialize(this.config.initializeTimeoutMs);
      this.clients.set(key, client);
      child.once('exit', (code, signal) => {
        if (this.clients.get(key) !== client) return;
        this.clients.delete(key);
        this.broken.set(key, {
          until: Date.now() + this.config.brokenServerCooldownMs,
          detail: `LSP process exited (code=${code ?? 'null'}, signal=${signal ?? 'none'}).`,
        });
      });
      return client;
    } catch (error: any) {
      if (child && child.exitCode === null && !child.killed) child.kill();
      const detail = [error.message, stderr.trim()].filter(Boolean).join(' | ').slice(0, 2_000);
      this.broken.set(key, { until: Date.now() + this.config.brokenServerCooldownMs, detail });
      return undefined;
    }
  }

  private isInsideWorkspace(target: string): boolean {
    const relative = path.relative(this.workspace.rootDir, path.resolve(target));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }
}

export function resolveLspSpawnInvocation(command: string[]): { file: string; args: string[] } {
  if (command.length === 0 || !command[0]) throw new Error('LSP command is empty.');
  const executable = command[0];
  const extension = path.extname(executable).toLowerCase();
  const needsCommandInterpreter = process.platform === 'win32'
    && (extension === '' || extension === '.cmd' || extension === '.bat');
  if (!needsCommandInterpreter) return { file: executable, args: command.slice(1) };
  const commandLine = command.map(quoteWindowsCommandToken).join(' ');
  return {
    file: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', commandLine],
  };
}

function quoteWindowsCommandToken(token: string): string {
  if (!token || /[&|<>^%!"\r\n()]/.test(token)) {
    throw new Error('Unsafe character in Windows LSP command token.');
  }
  return `"${token}"`;
}

const managerCache = new WeakMap<Workspace, LspManager>();

export function getOrCreateLspManager(workspace: Workspace): LspManager {
  let manager = managerCache.get(workspace);
  if (!manager) {
    manager = new LspManager(workspace);
    managerCache.set(workspace, manager);
  }
  return manager;
}

export async function disposeLspManager(workspace: Workspace): Promise<void> {
  const manager = managerCache.get(workspace);
  managerCache.delete(workspace);
  await manager?.shutdown();
}

function normalizeDiagnostic(file: string, item: any, provider: string): NormalizedLspDiagnostic {
  const severity = Number(item?.severity || 1);
  return {
    file,
    line: Number(item?.range?.start?.line || 0) + 1,
    character: Number(item?.range?.start?.character || 0) + 1,
    endLine: Number(item?.range?.end?.line || item?.range?.start?.line || 0) + 1,
    endCharacter: Number(item?.range?.end?.character || item?.range?.start?.character || 0) + 1,
    message: String(item?.message || ''),
    ...(item?.code !== undefined ? { code: item.code } : {}),
    ...(item?.source ? { source: String(item.source) } : {}),
    category: severity === 2 ? 'warning' : severity === 3 ? 'information' : severity === 4 ? 'hint' : 'error',
    provider,
  };
}

function dedupeDiagnostics(items: NormalizedLspDiagnostic[]): NormalizedLspDiagnostic[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.file}:${item.line}:${item.character}:${item.code ?? ''}:${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeUris(value: any, workspace: Workspace): any {
  if (Array.isArray(value)) return value.map((item) => normalizeUris(item, workspace));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    if ((key === 'uri' || key === 'targetUri') && typeof item === 'string' && item.startsWith('file:')) {
      try {
        const absolute = fileURLToPath(item);
        output[key] = isWithin(workspace.rootDir, absolute) ? workspace.toRelativePath(absolute) : item;
      } catch { output[key] = item; }
    } else {
      output[key] = normalizeUris(item, workspace);
    }
  }
  return output;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizePathKey(value: string): string {
  const normalized = path.resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function makeKey(id: string, root: string): string {
  return `${id}\u0000${normalizePathKey(root)}`;
}

function splitKey(key: string): [string, string] {
  const index = key.indexOf('\u0000');
  return [key.slice(0, index), key.slice(index + 1)];
}

function samePath(left: string, right: string): boolean {
  return normalizePathKey(left) === normalizePathKey(right);
}
