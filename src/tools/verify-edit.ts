import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createPatch } from 'diff';
import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { PatchEngine } from '../patch/patch-engine.js';
import { findTextMatches, type TextMatch } from './replace-text.js';

interface VerifiedMatch {
  line: number;
  startOffset: number;
  endOffset: number;
  strategy: TextMatch['strategy'];
  preview: string;
}

function hashContent(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

function normalizeHash(hash: string): string {
  const trimmed = hash.trim().toLowerCase();
  return trimmed.startsWith('sha256:') ? trimmed.slice(7) : trimmed;
}

function previewAround(content: string, match: TextMatch): string {
  const lines = content.split('\n');
  const idx = Math.max(0, match.line - 1);
  return lines.slice(Math.max(0, idx - 1), idx + 2).join('\n').slice(0, 600);
}

function toVerifiedMatch(content: string, match: TextMatch): VerifiedMatch {
  return {
    line: match.line,
    startOffset: match.start,
    endOffset: match.end,
    strategy: match.strategy,
    preview: previewAround(content, match),
  };
}

/**
 * Tool: verify_edit
 * Read-only dry-run verification for replace_text / apply_patch.
 * Never writes to disk, never acquires locks, never invalidates caches.
 */
export const verifyEditTool: ToolDefinition = {
  name: 'verify_edit',
  description: 'Dry-run verification for a planned replace_text or apply_patch call. Checks whether oldText (or a unified diff patch) matches the current on-disk content and returns match positions, match strategy, an optional diff preview, and the current file hash — without writing anything. Call this before replace_text/apply_patch when the anchor is uncertain, stale, or was copied from an older read. A verified:false result means the mutation would fail; re-read the file and rebuild the anchor instead of retrying blindly.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: 'Workspace-relative path of the target file. Required for oldText mode; for patch mode it is only needed when the patch contains bare @@ hunks without --- / +++ headers.',
      },
      oldText: {
        type: Type.STRING,
        description: 'Candidate anchor block copied from the file. Provide exactly one of oldText or patch.',
      },
      patch: {
        type: Type.STRING,
        description: 'Candidate unified diff patch. Provide exactly one of oldText or patch.',
      },
      newText: {
        type: Type.STRING,
        description: 'Optional replacement text used only to render a diff preview when oldText matches exactly once. Nothing is written.',
      },
      matchMode: {
        type: Type.STRING,
        enum: ['auto', 'exact'],
        description: 'Match tolerance for oldText mode (default auto: accepts LF/CRLF, Unicode NFC/NFD, indentation and whitespace equivalents).',
      },
      expectedFileHash: {
        type: Type.STRING,
        description: 'Optional contentHash from the latest read_file. When provided, the result reports whether the file changed since that read.',
      },
      fuzzLevel: {
        type: Type.INTEGER,
        description: 'Patch mode only: accepted deviation level 0-3 (default 2, same scale as apply_patch).',
      },
    },
    required: [],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const rawPath = String(args.path || args.filePath || args.targetFile || '').trim();
    const oldText = args.oldText !== undefined && args.oldText !== null ? String(args.oldText) : '';
    const patch = args.patch !== undefined && args.patch !== null ? String(args.patch).trim() : '';
    const newText = args.newText !== undefined && args.newText !== null ? String(args.newText) : undefined;
    const matchMode = args.matchMode === 'exact' ? 'exact' : 'auto';
    const fuzzLevel = typeof args.fuzzLevel === 'number' ? Math.max(0, Math.min(3, args.fuzzLevel)) : 2;
    const expectedFileHash = args.expectedFileHash === undefined ? undefined : String(args.expectedFileHash).trim();

    const hasOldText = oldText.length > 0;
    const hasPatch = patch.length > 0;
    if (hasOldText === hasPatch) {
      return {
        success: false,
        verified: false,
        error: 'Provide exactly one of "oldText" or "patch".',
        errorCode: 'INVALID_ARGS',
        suggestion: 'Use oldText to verify a replace_text anchor, or patch to verify an apply_patch diff.',
      };
    }

    try {
      if (hasOldText) {
        return await verifyOldText(rawPath, oldText, newText, matchMode, expectedFileHash, workspace);
      }
      return await verifyPatch(rawPath, patch, fuzzLevel, expectedFileHash, workspace);
    } catch (err: any) {
      return {
        success: false,
        verified: false,
        error: `Dry-run verification failed: ${err.message}`,
        errorCode: 'EXECUTION_ERROR',
      };
    }
  },
};

async function readTarget(rawPath: string, workspace: Workspace): Promise<{ safePath: string; content: string; fileHash: string }> {
  if (!rawPath) {
    throw Object.assign(new Error('Parameter "path" is required for oldText mode.'), { code: 'INVALID_ARGS' });
  }
  const safePath = workspace.resolveSafePath(rawPath);
  let stat;
  try {
    stat = await fs.stat(safePath);
  } catch (statErr: any) {
    if (statErr.code === 'ENOENT') {
      let similarFiles: string[] = [];
      try {
        similarFiles = await workspace.findSimilarWorkspaceFiles(rawPath, 3);
      } catch { /* noop */ }
      throw Object.assign(
        new Error(`File "${rawPath}" does not exist (ENOENT).${similarFiles.length > 0 ? ` Similar files: ${JSON.stringify(similarFiles)}.` : ''}`),
        { code: 'FILE_NOT_FOUND' },
      );
    }
    throw statErr;
  }
  if (!stat.isFile()) {
    throw Object.assign(new Error(`"${rawPath}" is not a file.`), { code: 'NOT_A_FILE' });
  }
  const content = await fs.readFile(safePath, 'utf-8');
  return { safePath, content, fileHash: hashContent(content) };
}

async function verifyOldText(
  rawPath: string,
  oldText: string,
  newText: string | undefined,
  matchMode: 'auto' | 'exact',
  expectedFileHash: string | undefined,
  workspace: Workspace,
): Promise<Record<string, any>> {
  let target: { safePath: string; content: string; fileHash: string };
  try {
    target = await readTarget(rawPath, workspace);
  } catch (err: any) {
    return {
      success: false,
      verified: false,
      path: rawPath,
      error: err.message,
      errorCode: (err as any).code || 'EXECUTION_ERROR',
    };
  }
  const { content, fileHash } = target;
  const fileHashMatches = expectedFileHash ? normalizeHash(expectedFileHash) === normalizeHash(fileHash) || (normalizeHash(expectedFileHash).length >= 8 && normalizeHash(fileHash).startsWith(normalizeHash(expectedFileHash))) : undefined;

  const matches = findTextMatches(content, oldText, matchMode);
  const verified = matches.length === 1;
  const suggestions: string[] = [];
  if (matches.length === 0) {
    suggestions.push('No match: re-read the file with read_file and copy a 3-15 line anchor from the current content.');
  } else if (matches.length > 1) {
    suggestions.push(`Ambiguous anchor (${matches.length} matches): extend oldText with unique surrounding context, then verify again.`);
  }
  if (fileHashMatches === false) {
    suggestions.push('File changed since the provided expectedFileHash: re-read before mutating.');
  }

  let dryRunDiff: string | undefined;
  if (verified && newText !== undefined) {
    const match = matches[0];
    const updated = content.slice(0, match.start) + newText + content.slice(match.end);
    const patchText = createPatch(rawPath, content, updated, 'before', 'after');
    dryRunDiff = patchText.length > 4000 ? patchText.slice(0, 4000) + '\n... [diff truncated]' : patchText;
  }

  return {
    success: true,
    verified,
    mode: 'oldText',
    path: rawPath,
    fileHash,
    ...(fileHashMatches !== undefined ? { fileHashMatches } : {}),
    matchCount: matches.length,
    matches: matches.slice(0, 10).map((m) => toVerifiedMatch(content, m)),
    ...(dryRunDiff ? { dryRunDiff } : {}),
    suggestions,
  };
}

async function verifyPatch(
  rawPath: string,
  patch: string,
  fuzzLevel: number,
  expectedFileHash: string | undefined,
  workspace: Workspace,
): Promise<Record<string, any>> {
  let parsed: ReturnType<typeof PatchEngine.parsePatch>;
  try {
    parsed = PatchEngine.parsePatch(patch, rawPath || undefined);
  } catch (err: any) {
    return {
      success: false,
      verified: false,
      error: `Patch parse failed: ${err.message}`,
      errorCode: 'INVALID_PATCH',
    };
  }
  if (parsed.files.length === 0) {
    return {
      success: false,
      verified: false,
      error: 'Patch contains no valid file or hunk.',
      errorCode: 'INVALID_PATCH',
    };
  }

  const result = await PatchEngine.applyPatch(parsed, workspace, {
    defaultPath: rawPath || undefined,
    maxFuzzLevel: fuzzLevel,
    dryRun: true,
  });

  const files = result.fileResults.map((f) => {
    const failedHunk = f.hunkResults.find((h) => !h.applied);
    return {
      path: f.path,
      type: f.type,
      verified: f.success,
      hunksTotal: f.hunksTotal,
      hunksApplied: f.hunksApplied,
      fuzzLevelUsed: f.fuzzLevelUsed,
      ...(f.error ? { error: f.error } : {}),
      ...(failedHunk
        ? {
            failedHunkIndex: failedHunk.hunkIndex + 1,
            suggestedRead: {
              path: f.path,
              startLine: 1,
              endLine: 30,
            },
          }
        : {}),
    };
  });

  const suggestions: string[] = [];
  if (!result.success) {
    suggestions.push('Dry-run failed: re-read the failing file region with read_file, rebuild the patch against current content, and verify again.');
  }
  if (expectedFileHash !== undefined && parsed.files.length === 1) {
    suggestions.push('Note: single-file expectedFileHash cross-check is done by apply_patch itself at commit time; this dry-run reports match status only.');
  }

  return {
    success: true,
    verified: result.success,
    mode: 'patch',
    totalHunks: result.totalHunks,
    hunksApplied: result.hunksApplied,
    files,
    ...(result.error ? { error: result.error } : {}),
    suggestions,
  };
}
