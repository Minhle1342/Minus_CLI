import path from 'node:path';
import fs from 'node:fs';
import type { ToolDefinition } from '../tools/types.js';
import { ToolDescriptorRegistry } from './tool-descriptor-registry.js';
import { SandboxPolicyEngine } from '../sandbox/sandbox-policy.js';
import { classifyGitCommand } from '../tools/git-command-policy.js';
import { parseShellAst } from '../security/shell-ast-parser.js';

/**
 * Delegation/control tools spawn child agents; they never touch the workspace.
 * Explore/plan masking exists to protect files before implementation, so these
 * stay legal in every phase (otherwise the model never even sees a way to delegate).
 */
export const ORCHESTRATION_TOOL_NAMES = new Set([
  'delegate_task', 'delegate_agent', 'spawn_agent', 'wait_agent', 'get_agent_result',
  'stop_agent', 'resume_agent', 'message_agent', 'allocate_agent_task', 'schedule_dag_parallel',
  'verify_subagent_quality', 'brainstorm_design',
]);

export function isOrchestrationTool(name: string): boolean {
  return ORCHESTRATION_TOOL_NAMES.has(name);
}

/** Orchestration tools that create new work (vs. just steering existing agents). */
export const ORCHESTRATION_SPAWN_TOOL_NAMES = new Set([
  'delegate_task', 'delegate_agent', 'spawn_agent', 'allocate_agent_task', 'schedule_dag_parallel',
  // Design review spawn subagent thật nên coi như spawn mới — cần intent delegate (shortcut: thêm tên
  // vào set này là mọi lệnh design review đều yêu cầu capability 'delegate'; ceiling: nếu có tool
  // orchestration mới nào spawn work khác thì thêm vào đây, không sửa gate thủ công.
  'brainstorm_design',
]);

function isReadingWorkspaceCodebase(command: string, workspaceRoot: string): boolean {
  const analysis = parseShellAst(command.trim());
  const FILE_READERS = new Set(['cat', 'type', 'get-content', 'gc', 'head', 'tail', 'more', 'less', 'sed']);
  for (const cmd of analysis.commands) {
    const executable = cmd.executable.toLowerCase();
    if (FILE_READERS.has(executable)) {
      for (const arg of cmd.args) {
        if (arg.startsWith('-') || /^\d+$/.test(arg)) continue;
        if (['/dev/null', 'nul', 'con', '/dev/stdout', '/dev/stderr'].includes(arg.toLowerCase())) continue;
        try {
          const resolved = path.resolve(workspaceRoot, arg);
          const wsResolved = path.resolve(workspaceRoot);
          if (resolved.startsWith(wsResolved) && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
            return true;
          }
        } catch {
          // ignore
        }
      }
    }
  }
  return false;
}

/** Enforce argument-dependent effects on both early and ordinary dispatch paths. */
export function checkPhaseToolEffect(
  tool: ToolDefinition,
  args: Record<string, any>,
  phase: string,
  workspaceRoot: string,
): { allowed: boolean; reason?: string } {
  if (phase !== 'explore' && phase !== 'plan') return { allowed: true };
  if (isOrchestrationTool(tool.name)) return { allowed: true };
  if (tool.name === 'run_command') {
    const command = String(args.command || args.CommandLine || args.commandLine || args.cmd || args.rawCommand || args.script || '');
    if (isReadingWorkspaceCodebase(command, workspaceRoot)) {
      return {
        allowed: false,
        reason: 'Reading workspace codebase files through shell is not allowed in explore/plan phase; use dedicated read_file tool instead.',
      };
    }
    const result = new SandboxPolicyEngine(workspaceRoot, 'strict').evaluateCommand(command, args.cwd);
    return result.allowed ? { allowed: true } : { allowed: false, reason: result.reason || 'Only inspected read-only command effects are allowed before implementation.' };
  }
  if (tool.name === 'git_command') {
    const subcommand = String(args.subcommand || '');
    const argv = Array.isArray(args.args) ? args.args.map(String) : [];
    const safe = /^[a-z-]+$/i.test(subcommand)
      && !argv.some(arg => /^--(?:output|ext-diff|textconv|exec-path)(?:=|$)/i.test(arg))
      && classifyGitCommand(subcommand, argv).risk === 'read';
    return safe ? { allowed: true } : { allowed: false, reason: 'Git writes require implementation/release authority and matching user authorization.' };
  }
  if (new ToolDescriptorRegistry().describe(tool).mutates || tool.name === 'run_test_suite') {
    return { allowed: false, reason: `Tool "${tool.name}" can change state; request an implementation transition and wait for refreshed authority.` };
  }
  return { allowed: true };
}
