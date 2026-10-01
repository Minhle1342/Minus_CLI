import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

export interface CodeGraphStatus {
  available: boolean;
  indexed: boolean;
  binary: string;
  version?: string;
  dbPath?: string;
  hint?: string;
}

const COMMAND_TIMEOUT_MS = Number(process.env.CODEGRAPH_TIMEOUT_MS || 60_000);

function runBinary(binary: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || stdout || err.message).slice(0, 2000);
        reject(new Error(`codegraph ${args[0] || ''} failed: ${detail}`));
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

function resolveBinary(): string {
  return process.env.CODEGRAPH_BIN || 'codegraph';
}

/** Sync variant for hot paths (RATS retrieval) — pure existsSync, no subprocess. */
export function hasCodeGraphIndexSync(workspaceDir: string): boolean {
  try {
    return fsSync.statSync(path.join(path.resolve(workspaceDir), '.codegraph')).isDirectory();
  } catch {
    return false;
  }
}

/** Check `.codegraph/` marker without spawning a process. */
export async function hasCodeGraphIndex(workspaceDir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(path.resolve(workspaceDir), '.codegraph'));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export async function getCodeGraphStatus(workspaceDir: string): Promise<CodeGraphStatus> {
  const root = path.resolve(workspaceDir);
  const indexed = await hasCodeGraphIndex(root);
  const binary = resolveBinary();
  try {
    const out = await runBinary(binary, ['version'], root);
    const version = out.trim().split('\n')[0]?.slice(0, 120);
    return {
      available: true,
      indexed,
      binary,
      version,
      dbPath: indexed ? path.join(root, '.codegraph', 'codegraph.db') : undefined,
      hint: indexed ? undefined : 'Chạy `codegraph init` trong project để build graph.',
    };
  } catch {
    return {
      available: false,
      indexed,
      binary,
      hint: 'Chưa cài CodeGraph. Cài: npm i -g @colbymchenry/codegraph rồi chạy `codegraph init` trong project.',
    };
  }
}

function jsonFlag(): string[] {
  return ['--json'];
}

async function runJson<T>(workspaceDir: string, args: string[]): Promise<T> {
  const out = await runBinary(resolveBinary(), [...args, '--json'], path.resolve(workspaceDir));
  try {
    return JSON.parse(out) as T;
  } catch {
    // Some commands print human text even with --json; return raw text.
    return { raw: out.slice(0, 20000) } as unknown as T;
  }
}

async function runText(workspaceDir: string, args: string[]): Promise<string> {
  const out = await runBinary(resolveBinary(), args, path.resolve(workspaceDir));
  return out.slice(0, 20000);
}

/** Thin wrapper over the `codegraph` CLI. All methods throw when binary/index is missing. */
export const codeGraphClient = {
  status: (workspaceDir: string) => getCodeGraphStatus(workspaceDir),
  hasIndex: (workspaceDir: string) => hasCodeGraphIndex(workspaceDir),
  explore: (workspaceDir: string, query: string) => runText(workspaceDir, ['explore', query]),
  node: (workspaceDir: string, target: string) => runText(workspaceDir, ['node', target]),
  search: (workspaceDir: string, query: string, limit = 20) =>
    runJson(workspaceDir, ['query', query, '--limit', String(limit)]),
  callers: (workspaceDir: string, symbol: string, limit = 20) =>
    runJson(workspaceDir, ['callers', symbol, '--limit', String(limit)]),
  callees: (workspaceDir: string, symbol: string, limit = 20) =>
    runJson(workspaceDir, ['callees', symbol, '--limit', String(limit)]),
  impact: (workspaceDir: string, symbol: string, depth = 2) =>
    runJson(workspaceDir, ['impact', symbol, '--depth', String(depth)]),
  files: (workspaceDir: string) => runText(workspaceDir, ['files']),
};
