import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Workspace } from './workspace.js';

const execAsync = promisify(exec);

export interface WorkspaceStatusSnapshot {
  isGitRepo: boolean;
  isClean: boolean;
  modifiedFiles: string[];
  untrackedFiles: string[];
  untrackedTempFiles: string[];
  diffSummary: string;
  diffHash: string;
  timestamp: string;
}

export interface CleanlinessCheckResult {
  valid: boolean;
  violations: string[];
  snapshot: WorkspaceStatusSnapshot;
}

const FORBIDDEN_TEMP_PATTERNS = [
  /\.(tmp|bak|swp|swo|orig)$/i,
  /(^|\/)debug-.*\.log$/i,
  /(^|\/)\.DS_Store$/i,
  /(^|\/)npm-debug\.log/i,
  /(^|\/)yarn-error\.log/i,
];

/**
 * WorkspaceStateVerifier - Codex CLI Git Status & Diff Ledger
 * 
 * Verifies live filesystem changes against the physical working tree:
 * 1. Checks git status --porcelain for modified/untracked files.
 * 2. Computes diffHash for verifiable cryptographic change tracking.
 * 3. Audits for forbidden temporary/debug artifacts before task submission.
 */
export class WorkspaceStateVerifier {
  private workspaceDir: string;

  constructor(workspaceOrDir: Workspace | string) {
    this.workspaceDir = typeof workspaceOrDir === 'string'
      ? path.resolve(workspaceOrDir)
      : path.resolve(workspaceOrDir.rootDir);
  }

  /**
   * Capture a full physical status snapshot of the workspace
   */
  async captureStatus(): Promise<WorkspaceStatusSnapshot> {
    const timestamp = new Date().toISOString();
    try {
      const { stdout: isGitOut } = await execAsync('git rev-parse --is-inside-work-tree', {
        cwd: this.workspaceDir,
      });
      const isGitRepo = isGitOut.trim() === 'true';

      if (!isGitRepo) {
        return {
          isGitRepo: false,
          isClean: true,
          modifiedFiles: [],
          untrackedFiles: [],
          untrackedTempFiles: [],
          diffSummary: 'Not a Git repository.',
          diffHash: '0000000000000000',
          timestamp,
        };
      }

      const { stdout: statusOut } = await execAsync('git status --porcelain', {
        cwd: this.workspaceDir,
      });

      const modifiedFiles: string[] = [];
      const untrackedFiles: string[] = [];
      const untrackedTempFiles: string[] = [];

      const lines = statusOut.split('\n').map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        const statusCode = line.slice(0, 2).trim();
        const filePath = line.slice(3).trim();

        if (statusCode === '??') {
          untrackedFiles.push(filePath);
          if (FORBIDDEN_TEMP_PATTERNS.some((p) => p.test(filePath))) {
            untrackedTempFiles.push(filePath);
          }
        } else {
          modifiedFiles.push(filePath);
        }
      }

      const { stdout: diffOut } = await execAsync('git diff HEAD', {
        cwd: this.workspaceDir,
      });

      const diffSummary = diffOut.slice(0, 800);
      const diffHash = crypto.createHash('sha256').update(diffOut).digest('hex').slice(0, 16);
      const isClean = modifiedFiles.length === 0 && untrackedFiles.length === 0;

      return {
        isGitRepo: true,
        isClean,
        modifiedFiles,
        untrackedFiles,
        untrackedTempFiles,
        diffSummary,
        diffHash,
        timestamp,
      };
    } catch {
      return {
        isGitRepo: false,
        isClean: true,
        modifiedFiles: [],
        untrackedFiles: [],
        untrackedTempFiles: [],
        diffSummary: 'Workspace status scan unavailable.',
        diffHash: 'ffffffffffffffff',
        timestamp,
      };
    }
  }

  /**
   * Audits workspace cleanliness before accepting solution submission
   */
  async checkCleanliness(expectedModifiedFiles?: string[]): Promise<CleanlinessCheckResult> {
    const snapshot = await this.captureStatus();
    const violations: string[] = [];

    // 1. Check for forbidden untracked temporary files
    if (snapshot.untrackedTempFiles.length > 0) {
      violations.push(
        `Leftover temporary/debug files detected: ${snapshot.untrackedTempFiles.join(', ')}. Clean them up before submitting.`,
      );
    }

    // 2. If expectedModifiedFiles provided, check if actual modified files align
    if (expectedModifiedFiles && expectedModifiedFiles.length > 0 && snapshot.isGitRepo) {
      const normalizedExpected = new Set(expectedModifiedFiles.map((f) => path.normalize(f)));
      const actualModified = snapshot.modifiedFiles.map((f) => path.normalize(f));
      
      const unannouncedMods = actualModified.filter((f) => !normalizedExpected.has(f));
      if (unannouncedMods.length > 0) {
        violations.push(
          `Unexpected unannounced file modifications found in git status: ${unannouncedMods.join(', ')}.`,
        );
      }
    }

    return {
      valid: violations.length === 0,
      violations,
      snapshot,
    };
  }
}
