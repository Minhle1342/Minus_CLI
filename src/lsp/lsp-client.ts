import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { JsonRpcConnection } from './json-rpc-connection.js';
import type { LspDiagnostic, LspOperation, LspPosition, LspServerConfig } from './types.js';

interface DiagnosticEntry {
  diagnostics: LspDiagnostic[];
  version?: number;
  updatedAt: number;
}

const LANGUAGE_IDS: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact',
  '.mjs': 'javascript', '.cjs': 'javascript', '.mts': 'typescript', '.cts': 'typescript',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.cs': 'csharp',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp', '.json': 'json',
  '.yaml': 'yaml', '.yml': 'yaml', '.lua': 'lua', '.sh': 'shellscript', '.ps1': 'powershell',
};

export class LspClient {
  readonly connection: JsonRpcConnection;
  private capabilities: any = {};
  private documents = new Map<string, { version: number; text: string }>();
  private diagnosticCache = new Map<string, DiagnosticEntry>();
  private diagnosticWaiters = new Map<string, Set<(entry: DiagnosticEntry) => void>>();

  constructor(
    readonly server: LspServerConfig,
    readonly root: string,
    private readonly directory: string,
    readonly process: ChildProcessWithoutNullStreams,
    requestTimeoutMs: number,
  ) {
    this.connection = new JsonRpcConnection(process, requestTimeoutMs);
    this.connection.onNotification('textDocument/publishDiagnostics', (params) => this.acceptPublishedDiagnostics(params));
    this.connection.onRequest('workspace/configuration', (params) => Array.isArray(params?.items) ? params.items.map(() => null) : []);
    this.connection.onRequest('workspace/workspaceFolders', () => [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }]);
    this.connection.onRequest('client/registerCapability', () => null);
    this.connection.onRequest('client/unregisterCapability', () => null);
    this.connection.onRequest('window/workDoneProgress/create', () => null);
    this.connection.onRequest('window/showMessageRequest', () => null);
    this.connection.onRequest('workspace/applyEdit', () => ({ applied: false, failureReason: 'The coding agent does not accept unsolicited LSP workspace edits.' }));
  }

  async initialize(timeoutMs: number): Promise<void> {
    const initialized = await this.connection.request<any>('initialize', {
      processId: process.pid,
      clientInfo: { name: 'Minus Coding Agent', version: '1.0.0' },
      rootUri: pathToFileURL(this.root).href,
      workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }],
      capabilities: {
        workspace: { workspaceFolders: true, symbol: { dynamicRegistration: true } },
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: true },
          publishDiagnostics: { relatedInformation: true, versionSupport: true },
          diagnostic: { dynamicRegistration: true, relatedDocumentSupport: true },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: true },
          references: {}, documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          implementation: { linkSupport: true }, callHierarchy: { dynamicRegistration: true },
        },
      },
      initializationOptions: this.server.initializationOptions,
    }, timeoutMs);
    this.capabilities = initialized?.capabilities || {};
    this.connection.notify('initialized', {});
  }

  async syncDocument(filePath: string, diagnosticsWaitMs = 0): Promise<LspDiagnostic[]> {
    const absolute = path.resolve(filePath);
    const uri = pathToFileURL(absolute).href;
    let text: string;
    try {
      text = await fs.readFile(absolute, 'utf8');
    } catch {
      if (this.documents.has(absolute)) {
        this.connection.notify('textDocument/didClose', { textDocument: { uri } });
        this.documents.delete(absolute);
        this.diagnosticCache.delete(absolute);
      }
      return [];
    }

    const previous = this.documents.get(absolute);
    const version = (previous?.version || 0) + 1;
    const after = Date.now();
    const changed = !previous || previous.text !== text;
    if (!previous) {
      this.connection.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: LANGUAGE_IDS[path.extname(absolute).toLowerCase()] || 'plaintext', version, text },
      });
    } else if (previous.text !== text) {
      const syncKind = typeof this.capabilities?.textDocumentSync === 'number'
        ? this.capabilities.textDocumentSync
        : this.capabilities?.textDocumentSync?.change;
      this.connection.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: syncKind === 2
          ? [{ range: { start: { line: 0, character: 0 }, end: endPosition(previous.text) }, text }]
          : [{ text }],
      });
    }
    this.documents.set(absolute, { version, text });

    if (!changed) return this.diagnosticCache.get(absolute)?.diagnostics || [];
    if (this.capabilities?.diagnosticProvider) {
      try {
        const pulled = await this.connection.request<any>('textDocument/diagnostic', {
          textDocument: { uri },
          previousResultId: undefined,
        }, Math.max(250, diagnosticsWaitMs));
        if (Array.isArray(pulled?.items)) this.storeDiagnostics(absolute, pulled.items, version);
      } catch {}
    }
    if (diagnosticsWaitMs > 0 && (!this.diagnosticCache.get(absolute) || this.diagnosticCache.get(absolute)!.updatedAt < after)) {
      await this.waitForDiagnostics(absolute, after, diagnosticsWaitMs);
    }
    return this.diagnosticCache.get(absolute)?.diagnostics || [];
  }

  getDiagnostics(filePath?: string): Map<string, LspDiagnostic[]> {
    const result = new Map<string, LspDiagnostic[]>();
    if (filePath) {
      const absolute = path.resolve(filePath);
      result.set(absolute, this.diagnosticCache.get(absolute)?.diagnostics || []);
      return result;
    }
    for (const [file, entry] of this.diagnosticCache) result.set(file, entry.diagnostics);
    return result;
  }

  async query(operation: LspOperation, filePath: string, position: LspPosition, query = ''): Promise<any[]> {
    await this.syncDocument(filePath);
    const uri = pathToFileURL(path.resolve(filePath)).href;
    if (operation === 'workspaceSymbol') {
      return normalizeArray(await this.connection.request('workspace/symbol', { query }));
    }
    if (operation === 'documentSymbol') {
      return normalizeArray(await this.connection.request('textDocument/documentSymbol', { textDocument: { uri } }));
    }
    if (operation === 'incomingCalls' || operation === 'outgoingCalls') {
      const prepared = normalizeArray(await this.connection.request('textDocument/prepareCallHierarchy', {
        textDocument: { uri }, position,
      }));
      if (prepared.length === 0) return [];
      return normalizeArray(await this.connection.request(`callHierarchy/${operation}`, { item: prepared[0] }));
    }
    const method: Record<LspOperation, string> = {
      hover: 'textDocument/hover',
      definition: 'textDocument/definition',
      references: 'textDocument/references',
      documentSymbol: 'textDocument/documentSymbol',
      workspaceSymbol: 'workspace/symbol',
      implementation: 'textDocument/implementation',
      prepareCallHierarchy: 'textDocument/prepareCallHierarchy',
      incomingCalls: 'callHierarchy/incomingCalls',
      outgoingCalls: 'callHierarchy/outgoingCalls',
    };
    const params: any = { textDocument: { uri }, position };
    if (operation === 'references') params.context = { includeDeclaration: true };
    return normalizeArray(await this.connection.request(method[operation], params));
  }

  async shutdown(): Promise<void> {
    try { await this.connection.request('shutdown', undefined, 1_000); } catch {}
    try { this.connection.notify('exit'); } catch {}
    const exitedCleanly = await waitForProcessExit(this.process, 750);
    if (!exitedCleanly && this.process.exitCode === null && !this.process.killed) this.process.kill();
    if (this.process.exitCode === null) await waitForProcessExit(this.process, 500);
    this.connection.dispose();
  }

  private acceptPublishedDiagnostics(params: any): void {
    if (!params || typeof params.uri !== 'string' || !Array.isArray(params.diagnostics)) return;
    try {
      const filePath = path.resolve(fileURLToPath(params.uri));
      this.storeDiagnostics(filePath, params.diagnostics, params.version);
    } catch {}
  }

  private storeDiagnostics(filePath: string, diagnostics: LspDiagnostic[], version?: number): void {
    const entry = { diagnostics, version, updatedAt: Date.now() };
    this.diagnosticCache.set(path.resolve(filePath), entry);
    const waiters = this.diagnosticWaiters.get(path.resolve(filePath));
    if (waiters) for (const resolve of [...waiters]) resolve(entry);
  }

  private async waitForDiagnostics(filePath: string, after: number, timeoutMs: number): Promise<void> {
    const absolute = path.resolve(filePath);
    await new Promise<void>((resolve) => {
      const handlers = this.diagnosticWaiters.get(absolute) || new Set<(entry: DiagnosticEntry) => void>();
      let timer: NodeJS.Timeout;
      const finish = () => {
        clearTimeout(timer);
        handlers.delete(onDiagnostics);
        if (handlers.size === 0) this.diagnosticWaiters.delete(absolute);
        resolve();
      };
      const onDiagnostics = (entry: DiagnosticEntry) => { if (entry.updatedAt >= after) finish(); };
      handlers.add(onDiagnostics);
      this.diagnosticWaiters.set(absolute, handlers);
      timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
    });
  }
}

function normalizeArray(value: any): any[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function endPosition(text: string): { line: number; character: number } {
  const lines = text.split(/\r?\n/);
  return { line: Math.max(0, lines.length - 1), character: lines[lines.length - 1]?.length || 0 };
}

function waitForProcessExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
    timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
  });
}
