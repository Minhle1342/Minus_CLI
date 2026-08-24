import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Workspace } from './workspace.js';

const execFileAsync = promisify(execFile);

export async function computeFileHash(filePath: string): Promise<string> {
  try {
    const buffer = await fs.readFile(filePath);
    return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
  } catch {
    return 'sha256:absent';
  }
}

export function computeStringHash(content: string): string {
  return `sha256:${crypto.createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

export async function computeWorkspaceDigest(workspace: Workspace): Promise<string> {
  const root = workspace.rootDir;
  const hash = crypto.createHash('sha256');

  try {
    // 1. Try git status --porcelain=v2 -z
    const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain=v2', '-z'], {
      cwd: root,
      maxBuffer: 10 * 1024 * 1024,
    });

    let headCommit = '';
    try {
      const { stdout: headOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
      headCommit = headOut.trim();
    } catch {
      headCommit = 'no-head';
    }

    hash.update(`git-head:${headCommit}\n`);
    hash.update(`git-status:${statusOut}\n`);

    // Include diff hash
    const diffHash = await computeDiffHash(workspace);
    hash.update(`git-diff:${diffHash}\n`);

    return `sha256:${hash.digest('hex')}`;
  } catch {
    // Fallback for non-git repository: scan files
    try {
      const entries: Array<{ relPath: string; hash: string }> = [];
      
      async function scanDir(dir: string) {
        const items = await fs.readdir(dir, { withFileTypes: true });
        for (const item of items) {
          if (workspace.isIgnoredDirectory(item.name)) continue;
          const fullPath = path.join(dir, item.name);
          if (item.isDirectory()) {
            await scanDir(fullPath);
          } else if (item.isFile() && !workspace.isBinaryFile(item.name)) {
            const relPath = workspace.toRelativePath(fullPath);
            const fileHash = await computeFileHash(fullPath);
            entries.push({ relPath, hash: fileHash });
          }
        }
      }

      await scanDir(root);
      entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
      for (const entry of entries) {
        hash.update(`${entry.relPath}:${entry.hash}\n`);
      }
      return `sha256:${hash.digest('hex')}`;
    } catch (err: any) {
      return `sha256:fallback_${Date.now()}`;
    }
  }
}

export async function computeDiffHash(workspace: Workspace): Promise<string> {
  const root = workspace.rootDir;
  try {
    const { stdout: diffOut } = await execFileAsync('git', ['diff', 'HEAD'], {
      cwd: root,
      maxBuffer: 20 * 1024 * 1024,
    });
    if (!diffOut || diffOut.trim().length === 0) {
      return 'sha256:clean';
    }
    return computeStringHash(diffOut);
  } catch {
    return 'sha256:no-git-diff';
  }
}
