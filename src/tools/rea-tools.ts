import { Type } from '@google/genai';
import path from 'node:path';
import type { ToolDefinition } from './types.js';
import type { Workspace } from '../workspace/workspace.js';
import { toolError, toolSuccess } from './tool-result.js';
import type { ReaMcpManager } from '../mcp/rea-mcp-manager.js';
import type { McpToolDescriptor } from '../mcp/types.js';

export const REA_TOOL_PREFIX = 'rea_';

const PLATFORM_HINT = process.platform === 'win32'
  ? 'Windows: static .NET/PE/JS analysis needs no engine; native needs Ghidra 12.1+JDK21, objdump, or Rizin (Hopper is macOS-only).'
  : 'Native analysis needs Hopper, Ghidra, IDA, objdump, or Rizin.';

/** REA tool names are prefixed so they never collide with core tools (e.g. get_call_graph). */
export function reaToolName(serverName: string): string {
  return `${REA_TOOL_PREFIX}${serverName}`;
}

const PATH_ARGS = new Set(['path']);
// Host filesystem keys on REA 6.x schemas. Device-internal (adb) and expected
// launcher paths are intentionally excluded: they are not host reads/writes.
const HOST_PATH_ARG = /^(?:path|managed_artifact|application_root|working_directory|(?!device_path$|expected_server_path$).*_path|.*_paths|.*_directory)$/;
// shortcut: only path-shaped REA document identifiers are sandboxed; add new
// filesystem args to HOST_PATH_ARG when upstream REA introduces them.

function guardReaValue(value: any, workspace: Workspace, key = '', depth = 0): any {
  if (depth > 6) return value;
  if (Array.isArray(value)) return value.map((item) => guardReaValue(item, workspace, key, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [childKey, child] of Object.entries(value)) {
      out[childKey] = guardReaValue(child, workspace, childKey, depth + 1);
    }
    return out;
  }
  if (typeof value !== 'string' || !value.trim()) return value;
  if (key === 'document') {
    return path.isAbsolute(value) || value.includes('/') || value.includes('\\')
      ? workspace.resolveSafePath(value)
      : value;
  }
  if (!HOST_PATH_ARG.test(key)) return value;
  return workspace.resolveSafePath(value);
}

/**
 * Workspace sandbox for REA arguments. REA runs as a separate process and would
 * otherwise open or write any file the OS allows, so host path arguments
 * (including nested and array values) are resolved through
 * Workspace.resolveSafePath exactly like read_file/run_command.
 */
export function guardReaArgs(args: Record<string, any>, workspace: Workspace): Record<string, any> {
  const safe = { ...args };
  for (const key of PATH_ARGS) {
    const value = safe[key];
    if (value === undefined || value === null) continue;
    if (!String(value).trim()) throw new Error(`Parameter "${key}" must not be empty.`);
  }
  return guardReaValue(safe, workspace) as Record<string, any>;
}

/**
 * One ToolDefinition per REA MCP tool, discovered at runtime from tools/list.
 * Non-path arguments pass through unchanged because REA owns their shape.
 */
export function createReaTools(manager: ReaMcpManager, descriptors: McpToolDescriptor[]): ToolDefinition[] {
  return descriptors
    .filter((d) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(d.name))
    .map((d) => ({
      name: reaToolName(d.name),
      description: `[REA reverse engineering] ${d.description || d.name}. ${PLATFORM_HINT} Call rea_binary_session with {} to check per-tool availability, then rea_open_binary. Target paths must be inside the workspace.`,
      parameters: toGeminiSchema(d.inputSchema),
      async execute(args: Record<string, any>, ws: Workspace) {
        let safeArgs: Record<string, any>;
        try {
          safeArgs = guardReaArgs(args, ws);
        } catch (err: any) {
          return toolError(err?.message || 'Path outside workspace.', 'SECURITY_VIOLATION' as any);
        }
        const res = await manager.callTool(d.name, safeArgs);
        if (!res.success) return toolError(res.error || `${d.name} failed`, 'EXECUTION_ERROR' as any);
        return toolSuccess({ tool: d.name, output: res.text || '', raw: res.content });
      },
    }));
}

const GEMINI_TYPES: Record<string, Type> = {
  object: Type.OBJECT,
  string: Type.STRING,
  number: Type.NUMBER,
  integer: Type.INTEGER,
  boolean: Type.BOOLEAN,
  array: Type.ARRAY,
  null: Type.NULL,
};

/** MCP sends JSON Schema (lowercase types); Gemini wants its Schema enum. */
function toGeminiSchema(schema: any, depth = 0): any {
  const source = schema && typeof schema === 'object' ? schema : {};
  const type = depth > 8 ? Type.OBJECT : (GEMINI_TYPES[String(source.type || 'object').toLowerCase()] || Type.OBJECT);
  const out: any = { type };
  if (typeof source.description === 'string') out.description = source.description;
  if (Array.isArray(source.enum)) out.enum = source.enum.map((v: any) => String(v));
  if (type === Type.OBJECT) {
    out.properties = {};
    for (const [key, value] of Object.entries(source.properties || {})) {
      out.properties[key] = toGeminiSchema(value, depth + 1);
    }
    if (Array.isArray(source.required) && source.required.length > 0) out.required = source.required;
  } else if (type === Type.ARRAY) {
    out.items = toGeminiSchema(source.items, depth + 1);
  }
  return out;
}
