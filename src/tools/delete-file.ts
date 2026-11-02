import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Type } from '@google/genai';
import type { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { toolError, toolSuccess } from './tool-result.js';
import { forceReleaseWindowsFileLock } from './windows-file-unlocker.js';

const SENSITIVE_TARGET_PATTERNS = [
  /\.env(\..+)?$/i,
  /(?:^|[\\/])\.git(?:[\\/]|$)/i,
  /\.gitconfig$/i,
  /\.ssh[\\/]/i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.npmrc/i,
];

function isProtected(target: string, resolved: string, workspace: Workspace): boolean {
  if (workspace.isProtectedFile(target) || workspace.isProtectedFile(resolved)) {
    return true;
  }
  const normalized = target.replace(/\\/g, '/');
  const base = path.basename(resolved);
  return SENSITIVE_TARGET_PATTERNS.some((pattern) => pattern.test(normalized) || pattern.test(base));
}

async function safeRemove(targetPath: string, isRecursive: boolean): Promise<void> {
  try {
    await fs.rm(targetPath, { recursive: isRecursive, force: true });
  } catch (err: any) {
    if (err.code === 'EBUSY' || err.code === 'EPERM') {
      if (process.platform === 'win32') {
        // Force-close locking process handles via Windows Restart Manager API
        await forceReleaseWindowsFileLock(targetPath);
      } else {
        await delay(100);
      }
      await fs.rm(targetPath, { recursive: isRecursive, force: true });
      return;
    }
    throw err;
  }
}

/**
 * delete_file: Xóa một hoặc nhiều file / thư mục trong workspace.
 * Hỗ trợ xóa đệ quy thư mục và có chốt chặn an toàn ranh giới workspace.
 */
export const deleteFileTool: ToolDefinition = {
  name: 'delete_file',
  description: 'Delete files or directories from workspace recursively. Batch delete multiple paths in one call with safety checks.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      paths: {
        type: Type.ARRAY,
        items: {
          type: Type.STRING,
        },
        description: 'Array of workspace-relative paths of files or directories to delete (e.g. ["temp.txt", "dist/", "build"]).',
      },
      path: {
        type: Type.STRING,
        description: 'Workspace-relative path of a single file or directory to delete (alternative to paths).',
      },
      recursive: {
        type: Type.BOOLEAN,
        description: 'Whether to recursively delete directories and nested contents (default: true).',
      },
      force: {
        type: Type.BOOLEAN,
        description: 'Ignore errors if paths do not exist (default: true).',
      },
    },
  },
  async execute(args: Record<string, any>, workspace: Workspace = new Workspace()): Promise<Record<string, any>> {
    // 1. Thu thập tất cả đường dẫn từ `paths`, `path` và các alias phổ biến
    const rawTargets: string[] = [];
    const addTarget = (val: unknown) => {
      if (typeof val === 'string' && val.trim()) {
        // Strip leading slash/backslash để tránh nhảy ra root ổ đĩa trên Windows
        const normalized = val.trim().replace(/^[/\\]+/, '');
        if (normalized) rawTargets.push(normalized);
      }
    };

    if (Array.isArray(args.paths)) args.paths.forEach(addTarget);
    if (Array.isArray(args.targetFiles)) args.targetFiles.forEach(addTarget);
    for (const key of ['path', 'filePath', 'file', 'target', 'filename', 'targetFile', 'targetPath']) {
      addTarget(args[key]);
    }

    const uniqueTargets = [...new Set(rawTargets)];
    if (uniqueTargets.length === 0) {
      return toolError('At least one path must be specified via "paths" or "path".', 'INVALID_ARGS');
    }

    const recursive = args.recursive !== false;
    const force = args.force !== false;

    const deleted: string[] = [];
    const notFound: string[] = [];
    const errors: Array<{ path: string; error: string }> = [];

    const wsRoot = path.resolve(workspace.rootDir);

    // 2. Kiểm tra an toàn trước khi thực hiện xóa (Pre-validation)
    for (const target of uniqueTargets) {
      let resolved: string;
      try {
        resolved = workspace.resolveSafePath(target);
      } catch (err: any) {
        return toolError(`Security violation for path "${target}": ${err.message}`, 'SECURITY_VIOLATION');
      }

      // Tuyệt đối không cho xóa thư mục gốc workspace
      if (path.resolve(resolved) === wsRoot || target === '.' || target === '') {
        return toolError('Deleting the workspace root directory is prohibited.', 'SECURITY_VIOLATION');
      }

      // Tuyệt đối không cho xóa các file được bảo vệ (.git, .env...)
      if (isProtected(target, resolved, workspace)) {
        return toolError(`Deleting protected file or configuration "${target}" is prohibited.`, 'SECURITY_VIOLATION');
      }
    }

    // 3. Thực thi xóa
    for (const target of uniqueTargets) {
      const resolved = workspace.resolveSafePath(target);
      try {
        const stats = await fs.lstat(resolved).catch(() => null);
        if (!stats) {
          notFound.push(target);
          if (!force) {
            errors.push({ path: target, error: 'Path does not exist' });
          }
          continue;
        }

        await safeRemove(resolved, recursive);
        deleted.push(target);
      } catch (err: any) {
        errors.push({ path: target, error: err.message });
      }
    }

    if (errors.length > 0 && deleted.length === 0) {
      return toolError(`Failed to delete items: ${errors.map((e) => `${e.path}: ${e.error}`).join(', ')}`, 'DELETE_FAILED' as any);
    }

    const summaryParts: string[] = [];
    if (deleted.length > 0) summaryParts.push(`Deleted ${deleted.length} item(s): ${deleted.join(', ')}`);
    if (notFound.length > 0) summaryParts.push(`Skipped ${notFound.length} non-existent item(s): ${notFound.join(', ')}`);
    if (errors.length > 0) summaryParts.push(`Failed ${errors.length} item(s): ${errors.map((e) => `${e.path} (${e.error})`).join(', ')}`);

    return toolSuccess({
      deleted,
      filesDeleted: deleted,
      notFound,
      changed: deleted.length > 0,
      errors: errors.length > 0 ? errors : undefined,
      message: summaryParts.join('; '),
    });
  },
};

export default deleteFileTool;
