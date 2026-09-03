import fs from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../../workspace/workspace.js';
import { getOrCreateTypeScriptService } from '../../tools/inspect-symbol.js';
import { CodeSyntaxValidator } from '../../workspace/syntax-diagnostics.js';
import type {
  WorkspaceState,
  ChangedFileState,
  DiagnosticSnapshot,
  DiagnosticItemSnapshot,
} from '../control-plane-state.js';
import { computeWorkspaceDigest, computeContentHash } from './workspace-digest.js';

interface CachedFileDiagnostics {
  errors: DiagnosticItemSnapshot[];
  warnings: DiagnosticItemSnapshot[];
  syntaxErrors: DiagnosticItemSnapshot[];
  unresolvedImports: DiagnosticItemSnapshot[];
}

export class WorkspaceStateManager {
  private state: WorkspaceState;
  private workspace: Workspace;
  private diagnosticCache = new Map<string, CachedFileDiagnostics>();

  constructor(workspace: Workspace, initialDigest = 'initial_digest') {
    this.workspace = workspace;
    this.state = {
      workspaceRoot: workspace.rootDir,
      workspaceDigest: initialDigest,
      dirty: false,
      activeMutationSeq: 0,
      lastVerifiedMutationSeq: 0,
      changedFiles: [],
      diagnostics: {
        errors: [],
        warnings: [],
        syntaxErrors: [],
        unresolvedImports: [],
        timestamp: Date.now(),
      },
      fileHashes: {},
    };
  }

  getState(): WorkspaceState {
    return { ...this.state };
  }

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
    this.state.workspaceRoot = workspace.rootDir;
    this.diagnosticCache.clear();
  }

  clearDiagnosticCache(): void {
    this.diagnosticCache.clear();
  }

  /**
   * Records a file mutation in the workspace state using in-memory content hashing.
   */
  recordMutation(params: {
    filePath: string;
    content?: string | Buffer;
    affectedSymbols?: string[];
    isRegistered?: boolean;
  }): { mutationSeq: number; changedFile: ChangedFileState; workspaceDigest: string } {
    this.state.activeMutationSeq++;
    const mutationSeq = this.state.activeMutationSeq;

    let contentHash = '';
    if (params.content !== undefined) {
      // In-memory hashing without disk read
      contentHash = computeContentHash(params.content);
    } else {
      try {
        const fullPath = path.isAbsolute(params.filePath)
          ? params.filePath
          : path.join(this.workspace.rootDir, params.filePath);
        if (fs.existsSync(fullPath)) {
          const fileBuf = fs.readFileSync(fullPath);
          contentHash = computeContentHash(fileBuf);
        }
      } catch {
        contentHash = computeContentHash(Date.now().toString());
      }
    }

    const normalizedPath = params.filePath.replace(/\\/g, '/');
    const ext = path.extname(params.filePath).slice(1);
    const changedFile: ChangedFileState = {
      path: normalizedPath,
      language: ext || 'text',
      contentHash,
      mutationSeq,
      isRegistered: params.isRegistered,
      affectedSymbols: params.affectedSymbols,
    };

    const idx = this.state.changedFiles.findIndex((f) => f.path === changedFile.path);
    if (idx >= 0) {
      this.state.changedFiles[idx] = changedFile;
    } else {
      this.state.changedFiles.push(changedFile);
    }

    this.state.fileHashes[changedFile.path] = contentHash;
    this.state.dirty = true;

    this.state.workspaceDigest = computeWorkspaceDigest({
      workspaceRoot: this.state.workspaceRoot,
      gitHead: this.state.gitHead,
      dirty: this.state.dirty,
      mutationSeq: this.state.activeMutationSeq,
      changedFiles: this.state.changedFiles,
      diagnostics: this.state.diagnostics,
    });

    return {
      mutationSeq,
      changedFile,
      workspaceDigest: this.state.workspaceDigest,
    };
  }

  /**
   * Captures fresh diagnostics across targeted/changed files in the workspace with content-hash memoization.
   */
  async refreshDiagnostics(targetFiles?: string[]): Promise<DiagnosticSnapshot> {
    const errors: DiagnosticItemSnapshot[] = [];
    const warnings: DiagnosticItemSnapshot[] = [];
    const syntaxErrors: DiagnosticItemSnapshot[] = [];
    const unresolvedImports: DiagnosticItemSnapshot[] = [];

    const filesToCheck = (targetFiles && targetFiles.length > 0)
      ? targetFiles
      : this.state.changedFiles.map((f) => f.path);

    if (filesToCheck.length > 0) {
      const uncachedFiles: string[] = [];

      for (const filePath of filesToCheck) {
        const normalized = filePath.replace(/\\/g, '/');
        const hash = this.state.fileHashes[normalized] || '';
        const cacheKey = `${normalized}::${hash}`;

        const cached = this.diagnosticCache.get(cacheKey);
        if (cached && hash.length > 0) {
          // Hit cache: append cached diagnostics in 0ms
          errors.push(...cached.errors);
          warnings.push(...cached.warnings);
          syntaxErrors.push(...cached.syntaxErrors);
          unresolvedImports.push(...cached.unresolvedImports);
        } else {
          uncachedFiles.push(filePath);
        }
      }

      // Compute diagnostics only for uncached files
      if (uncachedFiles.length > 0) {
        let tsService: ReturnType<typeof getOrCreateTypeScriptService> | undefined;
        try {
          tsService = getOrCreateTypeScriptService(this.workspace);
        } catch {}

        for (const filePath of uncachedFiles) {
          const fileErrors: DiagnosticItemSnapshot[] = [];
          const fileWarnings: DiagnosticItemSnapshot[] = [];
          const fileSyntaxErrors: DiagnosticItemSnapshot[] = [];
          const fileUnresolvedImports: DiagnosticItemSnapshot[] = [];

          // 1. TypeScript diagnostics
          if (tsService) {
            try {
              const allDiags = tsService.getDiagnostics(filePath);
              for (const d of allDiags) {
                const item: DiagnosticItemSnapshot = {
                  file: d.file,
                  line: d.line,
                  character: d.character,
                  code: d.code,
                  message: d.message,
                  category: d.category === 'error' ? 'error' : d.category === 'warning' ? 'warning' : 'info',
                };
                if (item.category === 'error') {
                  fileErrors.push(item);
                  if (
                    d.message.toLowerCase().includes('cannot find name') ||
                    d.message.toLowerCase().includes('cannot find module') ||
                    d.message.toLowerCase().includes('has no exported member')
                  ) {
                    fileUnresolvedImports.push(item);
                  }
                } else if (item.category === 'warning') {
                  fileWarnings.push(item);
                }
              }
            } catch {}
          }

          // 2. Syntax validation
          try {
            const syntaxDiags = await CodeSyntaxValidator.validateFiles([filePath], this.workspace);
            for (const d of syntaxDiags) {
              const item: DiagnosticItemSnapshot = {
                file: d.file,
                line: d.line,
                character: d.character,
                code: d.code,
                message: d.message,
                category: d.category === 'error' ? 'error' : 'warning',
              };
              if (item.category === 'error') {
                if (!fileErrors.some((e) => e.file === item.file && e.line === item.line && e.message === item.message)) {
                  fileErrors.push(item);
                }
                fileSyntaxErrors.push(item);
              }
            }
          } catch {}

          // Memoize into cache
          const normalized = filePath.replace(/\\/g, '/');
          const hash = this.state.fileHashes[normalized] || '';
          if (hash.length > 0) {
            this.diagnosticCache.set(`${normalized}::${hash}`, {
              errors: fileErrors,
              warnings: fileWarnings,
              syntaxErrors: fileSyntaxErrors,
              unresolvedImports: fileUnresolvedImports,
            });
          }

          errors.push(...fileErrors);
          warnings.push(...fileWarnings);
          syntaxErrors.push(...fileSyntaxErrors);
          unresolvedImports.push(...fileUnresolvedImports);
        }
      }
    }

    const snapshot: DiagnosticSnapshot = {
      errors,
      warnings,
      syntaxErrors,
      unresolvedImports,
      timestamp: Date.now(),
    };

    this.state.diagnostics = snapshot;
    this.state.workspaceDigest = computeWorkspaceDigest({
      workspaceRoot: this.state.workspaceRoot,
      gitHead: this.state.gitHead,
      dirty: this.state.dirty,
      mutationSeq: this.state.activeMutationSeq,
      changedFiles: this.state.changedFiles,
      diagnostics: this.state.diagnostics,
    });

    return snapshot;
  }
}
