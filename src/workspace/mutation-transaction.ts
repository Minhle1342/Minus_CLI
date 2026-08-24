import fs from 'node:fs/promises';
import path from 'node:path';
import type { Workspace } from './workspace.js';
import { computeFileHash, computeStringHash } from './workspace-digest.js';
import { toolError, toolSuccess, type ToolErrorResult } from '../tools/tool-result.js';

export type MutationOpType = 'create' | 'update' | 'delete' | 'move';

export interface StagedCreateOp {
  type: 'create';
  path: string;
  content: string;
  expectedAbsent?: boolean;
}

export interface StagedUpdateOp {
  type: 'update';
  path: string;
  newContent: string;
  expectedFileHash?: string;
}

export interface StagedDeleteOp {
  type: 'delete';
  path: string;
  expectedFileHash?: string;
  reason?: string;
}

export interface StagedMoveOp {
  type: 'move';
  sourcePath: string;
  targetPath: string;
  expectedSourceHash?: string;
}

export type StagedMutationOp = StagedCreateOp | StagedUpdateOp | StagedDeleteOp | StagedMoveOp;

export interface ChangedFileRecord {
  path: string;
  operation: MutationOpType;
  beforeHash: string;
  afterHash: string;
  bytes?: number;
}

export interface CommitResult {
  success: boolean;
  transactionId: string;
  changedFiles: ChangedFileRecord[];
  diffHash: string;
  error?: string;
  errorCode?: string;
}

export class MutationTransaction {
  readonly id: string;
  private workspace: Workspace;
  private ops: StagedMutationOp[] = [];

  constructor(workspace: Workspace, id?: string) {
    this.workspace = workspace;
    this.id = id || `tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  stageCreate(filePath: string, content: string, expectedAbsent: boolean = true): this {
    this.ops.push({
      type: 'create',
      path: filePath,
      content,
      expectedAbsent,
    });
    return this;
  }

  stageUpdate(filePath: string, newContent: string, expectedFileHash?: string): this {
    this.ops.push({
      type: 'update',
      path: filePath,
      newContent,
      expectedFileHash,
    });
    return this;
  }

  stageDelete(filePath: string, expectedFileHash?: string, reason?: string): this {
    this.ops.push({
      type: 'delete',
      path: filePath,
      expectedFileHash,
      reason,
    });
    return this;
  }

  stageMove(sourcePath: string, targetPath: string, expectedSourceHash?: string): this {
    this.ops.push({
      type: 'move',
      sourcePath,
      targetPath,
      expectedSourceHash,
    });
    return this;
  }

  getOps(): readonly StagedMutationOp[] {
    return [...this.ops];
  }

  /**
   * Chạy Preflight trên RAM: kiểm tra path, hash, existence, protected files mà chưa ghi đĩa
   */
  async preflight(): Promise<{ valid: true; plannedChanges: ChangedFileRecord[] } | ToolErrorResult> {
    const plannedChanges: ChangedFileRecord[] = [];

    for (const op of this.ops) {
      if (op.type === 'create') {
        const safePath = this.workspace.resolveSafePath(op.path);
        if (this.workspace.isProtectedFile(safePath)) {
          return toolError(
            `Security violation: Cannot create or overwrite protected configuration file "${op.path}".`,
            'SECURITY_VIOLATION',
          );
        }

        const currentHash = await computeFileHash(safePath);
        if (currentHash !== 'sha256:absent' && op.expectedAbsent !== false) {
          return toolError(
            `File "${op.path}" already exists on disk. create_file does not allow blind overwrite. Use replace_text or apply_patch to update.`,
            'FILE_ALREADY_EXISTS',
            { path: op.path, currentHash },
            'Inspect file with read_file before modifying, or use replace_text/apply_patch.',
          );
        }

        plannedChanges.push({
          path: this.workspace.toRelativePath(safePath),
          operation: 'create',
          beforeHash: currentHash,
          afterHash: computeStringHash(op.content),
          bytes: Buffer.byteLength(op.content, 'utf8'),
        });
      } else if (op.type === 'update') {
        const safePath = this.workspace.resolveSafePath(op.path);
        if (this.workspace.isProtectedFile(safePath)) {
          return toolError(
            `Security violation: Cannot modify protected configuration file "${op.path}".`,
            'SECURITY_VIOLATION',
          );
        }

        const currentHash = await computeFileHash(safePath);
        if (currentHash === 'sha256:absent') {
          return toolError(
            `File "${op.path}" does not exist to update.`,
            'FILE_NOT_FOUND',
            { path: op.path },
          );
        }

        if (op.expectedFileHash && op.expectedFileHash !== currentHash) {
          return toolError(
            `Content conflict (Stale File Hash) for "${op.path}". On-disk hash (${currentHash}) does not match expected hash (${op.expectedFileHash}).`,
            'STALE_FILE_HASH',
            { path: op.path, expectedHash: op.expectedFileHash, currentHash },
            'Use read_file to inspect latest content and hash before modifying.',
          );
        }

        plannedChanges.push({
          path: this.workspace.toRelativePath(safePath),
          operation: 'update',
          beforeHash: currentHash,
          afterHash: computeStringHash(op.newContent),
          bytes: Buffer.byteLength(op.newContent, 'utf8'),
        });
      } else if (op.type === 'delete') {
        const safePath = this.workspace.resolveSafePath(op.path);
        if (this.workspace.isProtectedFile(safePath)) {
          return toolError(
            `Bảo mật: Không được phép xóa file cấu hình nhạy cảm "${op.path}".`,
            'SECURITY_VIOLATION',
          );
        }

        const currentHash = await computeFileHash(safePath);
        if (currentHash === 'sha256:absent') {
          return toolError(
            `File "${op.path}" không tồn tại để xóa.`,
            'FILE_NOT_FOUND',
            { path: op.path },
          );
        }

        if (op.expectedFileHash && op.expectedFileHash !== currentHash) {
          return toolError(
            `Xung đột nội dung khi xóa file "${op.path}". Hash thực tế (${currentHash}) khác với expectedFileHash (${op.expectedFileHash}).`,
            'STALE_FILE_HASH',
            { path: op.path, expectedHash: op.expectedFileHash, currentHash },
          );
        }

        plannedChanges.push({
          path: this.workspace.toRelativePath(safePath),
          operation: 'delete',
          beforeHash: currentHash,
          afterHash: 'sha256:absent',
        });
      } else if (op.type === 'move') {
        const safeSource = this.workspace.resolveSafePath(op.sourcePath);
        const safeTarget = this.workspace.resolveSafePath(op.targetPath);

        if (this.workspace.isProtectedFile(safeSource) || this.workspace.isProtectedFile(safeTarget)) {
          return toolError(
            `Bảo mật: Không được phép di chuyển file cấu hình nhạy cảm.`,
            'SECURITY_VIOLATION',
          );
        }

        const sourceHash = await computeFileHash(safeSource);
        if (sourceHash === 'sha256:absent') {
          return toolError(
            `File nguồn "${op.sourcePath}" không tồn tại.`,
            'FILE_NOT_FOUND',
            { path: op.sourcePath },
          );
        }

        if (op.expectedSourceHash && op.expectedSourceHash !== sourceHash) {
          return toolError(
            `Xung đột nội dung cho file nguồn "${op.sourcePath}". Hash thực tế (${sourceHash}) khác với expectedSourceHash (${op.expectedSourceHash}).`,
            'STALE_FILE_HASH',
            { path: op.sourcePath, expectedHash: op.expectedSourceHash, currentHash: sourceHash },
          );
        }

        const targetHash = await computeFileHash(safeTarget);
        if (targetHash !== 'sha256:absent') {
          return toolError(
            `File đích "${op.targetPath}" đã tồn tại. Không thể ghi đè.`,
            'FILE_ALREADY_EXISTS',
            { path: op.targetPath },
          );
        }

        plannedChanges.push({
          path: this.workspace.toRelativePath(safeTarget),
          operation: 'move',
          beforeHash: sourceHash,
          afterHash: sourceHash,
        });
      }
    }

    return { valid: true, plannedChanges };
  }

  /**
   * Commit các thay đổi xuống đĩa với cơ chế compensating rollback nếu xảy ra lỗi I/O
   */
  async commit(): Promise<CommitResult> {
    const preflightRes = await this.preflight();
    if ('success' in preflightRes && !preflightRes.success) {
      return {
        success: false,
        transactionId: this.id,
        changedFiles: [],
        diffHash: 'sha256:preflight_failed',
        error: preflightRes.error,
        errorCode: preflightRes.errorCode,
      };
    }

    const { plannedChanges } = preflightRes as { valid: true; plannedChanges: ChangedFileRecord[] };
    const undoStack: Array<() => Promise<void>> = [];
    const changedFiles: ChangedFileRecord[] = [];

    try {
      for (const op of this.ops) {
        if (op.type === 'create') {
          const safePath = this.workspace.resolveSafePath(op.path);
          await fs.mkdir(path.dirname(safePath), { recursive: true });
          await fs.writeFile(safePath, op.content, 'utf8');

          undoStack.push(async () => {
            await fs.rm(safePath, { force: true });
          });

          changedFiles.push({
            path: this.workspace.toRelativePath(safePath),
            operation: 'create',
            beforeHash: 'sha256:absent',
            afterHash: computeStringHash(op.content),
            bytes: Buffer.byteLength(op.content, 'utf8'),
          });
        } else if (op.type === 'update') {
          const safePath = this.workspace.resolveSafePath(op.path);
          const originalContent = await fs.readFile(safePath, 'utf8');
          const beforeHash = computeStringHash(originalContent);

          await fs.writeFile(safePath, op.newContent, 'utf8');

          undoStack.push(async () => {
            await fs.writeFile(safePath, originalContent, 'utf8');
          });

          changedFiles.push({
            path: this.workspace.toRelativePath(safePath),
            operation: 'update',
            beforeHash,
            afterHash: computeStringHash(op.newContent),
            bytes: Buffer.byteLength(op.newContent, 'utf8'),
          });
        } else if (op.type === 'delete') {
          const safePath = this.workspace.resolveSafePath(op.path);
          const originalContent = await fs.readFile(safePath, 'utf8');
          const beforeHash = computeStringHash(originalContent);

          await fs.rm(safePath, { force: true });

          undoStack.push(async () => {
            await fs.mkdir(path.dirname(safePath), { recursive: true });
            await fs.writeFile(safePath, originalContent, 'utf8');
          });

          changedFiles.push({
            path: this.workspace.toRelativePath(safePath),
            operation: 'delete',
            beforeHash,
            afterHash: 'sha256:absent',
          });
        } else if (op.type === 'move') {
          const safeSource = this.workspace.resolveSafePath(op.sourcePath);
          const safeTarget = this.workspace.resolveSafePath(op.targetPath);
          const originalContent = await fs.readFile(safeSource, 'utf8');
          const beforeHash = computeStringHash(originalContent);

          await fs.mkdir(path.dirname(safeTarget), { recursive: true });
          await fs.rename(safeSource, safeTarget);

          undoStack.push(async () => {
            await fs.rename(safeTarget, safeSource);
          });

          changedFiles.push({
            path: this.workspace.toRelativePath(safeTarget),
            operation: 'move',
            beforeHash,
            afterHash: beforeHash,
          });
        }
      }

      const diffHash = computeStringHash(JSON.stringify(changedFiles));
      return {
        success: true,
        transactionId: this.id,
        changedFiles,
        diffHash,
      };
    } catch (err: any) {
      // Compensating rollback for all committed operations in reverse order
      for (const undo of undoStack.reverse()) {
        try {
          await undo();
        } catch {
          // ignore cleanup errors during rollback
        }
      }

      return {
        success: false,
        transactionId: this.id,
        changedFiles: [],
        diffHash: 'sha256:aborted',
        error: `Transaction commit failed: ${err.message}. All staged operations were safely rolled back.`,
        errorCode: 'TRANSACTION_ABORTED',
      };
    }
  }
}
