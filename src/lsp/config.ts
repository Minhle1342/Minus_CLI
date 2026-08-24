import fs from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../workspace/workspace.js';
import type { LspRuntimeConfig, LspServerConfig } from './types.js';

const SAFE_SERVER_EXECUTABLES = new Set([
  'typescript-language-server',
  'typescript-language-server.cmd',
  'pyright-langserver',
  'pyright-langserver.cmd',
  'basedpyright-langserver',
  'basedpyright-langserver.cmd',
  'gopls',
  'gopls.exe',
  'rust-analyzer',
  'rust-analyzer.exe',
  'clangd',
  'clangd.exe',
  'zls',
  'zls.exe',
  'jdtls',
  'jdtls.bat',
  'lua-language-server',
  'lua-language-server.exe',
  'yaml-language-server',
  'yaml-language-server.cmd',
  'vscode-json-language-server',
  'vscode-json-language-server.cmd',
  'bash-language-server',
  'bash-language-server.cmd',
  'docker-langserver',
  'docker-langserver.cmd',
  'biome',
  'biome.cmd',
]);

const DEFAULTS = {
  requestTimeoutMs: 5_000,
  initializeTimeoutMs: 30_000,
  diagnosticsWaitMs: 1_500,
  brokenServerCooldownMs: 30_000,
  maxDiagnosticsPerFile: 20,
};

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.floor(value)))
    : fallback;
}

function isTrustedCommand(command: string[], explicitlyTrusted: boolean): boolean {
  const requested = command[0] || '';
  const executable = path.basename(requested).toLowerCase();
  const isBareExecutable = requested === path.basename(requested);
  if (isBareExecutable && SAFE_SERVER_EXECUTABLES.has(executable)) return true;
  return explicitlyTrusted && process.env.MINUS_LSP_TRUST_CUSTOM === '1';
}

export function loadLspConfig(workspace: Workspace, overridePath?: string): LspRuntimeConfig {
  const warnings: string[] = [];
  const requestedPath = overridePath || process.env.MINUS_LSP_CONFIG || path.join('.minus', 'lsp.json');
  let configPath: string;
  try {
    configPath = workspace.resolveSafePath(requestedPath);
  } catch (error: any) {
    return { enabled: false, ...DEFAULTS, servers: [], warnings: [error.message] };
  }

  if (!fs.existsSync(configPath)) {
    return { enabled: false, ...DEFAULTS, servers: [], configPath, warnings };
  }

  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error: any) {
    return { enabled: false, ...DEFAULTS, servers: [], configPath, warnings: [`Invalid LSP config: ${error.message}`] };
  }

  const servers: LspServerConfig[] = [];
  const entries = raw?.servers && typeof raw.servers === 'object' ? Object.entries(raw.servers) : [];
  for (const [id, candidate] of entries) {
    const value = candidate as any;
    if (!value || value.disabled === true) continue;
    const command = Array.isArray(value.command)
      ? value.command.map(String).map((item: string) => item.trim()).filter(Boolean)
      : [];
    const extensions: string[] = Array.isArray(value.extensions)
      ? [...new Set<string>(value.extensions.map((item: unknown) => String(item).trim().toLowerCase()).filter((item: string) => item.startsWith('.') && item.length > 1))]
      : [];
    if (command.length === 0 || extensions.length === 0) {
      warnings.push(`LSP server "${id}" ignored: command[] and non-empty extensions[] are required.`);
      continue;
    }
    const trust = value.trust === true;
    if (!isTrustedCommand(command, trust)) {
      warnings.push(`LSP server "${id}" ignored: custom executable requires trust=true and MINUS_LSP_TRUST_CUSTOM=1.`);
      continue;
    }
    const env: Record<string, string> = {};
    if (value.env && typeof value.env === 'object') {
      for (const [key, envValue] of Object.entries(value.env)) {
        if (['PATH', 'PATHEXT', 'COMSPEC', 'NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase())) {
          warnings.push(`LSP server "${id}" ignored unsafe environment override: ${key}.`);
          continue;
        }
        env[key] = String(envValue);
      }
    }
    servers.push({
      id,
      command,
      extensions,
      rootMarkers: Array.isArray(value.rootMarkers)
        ? value.rootMarkers.map(String).map((item: string) => item.trim()).filter((item: string) => Boolean(item) && path.basename(item) === item && item !== '.' && item !== '..')
        : [],
      env,
      initializationOptions: value.initializationOptions,
      trust,
    });
  }

  return {
    enabled: raw?.enabled !== false && servers.length > 0,
    requestTimeoutMs: boundedNumber(raw?.requestTimeoutMs, DEFAULTS.requestTimeoutMs, 250, 60_000),
    initializeTimeoutMs: boundedNumber(raw?.initializeTimeoutMs, DEFAULTS.initializeTimeoutMs, 1_000, 120_000),
    diagnosticsWaitMs: boundedNumber(raw?.diagnosticsWaitMs, DEFAULTS.diagnosticsWaitMs, 0, 10_000),
    brokenServerCooldownMs: boundedNumber(raw?.brokenServerCooldownMs, DEFAULTS.brokenServerCooldownMs, 1_000, 300_000),
    maxDiagnosticsPerFile: boundedNumber(raw?.maxDiagnosticsPerFile, DEFAULTS.maxDiagnosticsPerFile, 1, 100),
    servers,
    configPath,
    warnings,
  };
}
