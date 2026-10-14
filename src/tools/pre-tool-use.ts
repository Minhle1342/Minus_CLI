import fs from 'node:fs';
import path from 'node:path';
import type { ToolExecutionContext } from './types.js';

export interface PreToolUseInput {
  toolName: string;
  args: Record<string, any>;
  context?: ToolExecutionContext;
  workspaceRoot?: string;
}

export interface PreToolUseVerdict {
  /** Cho phép tiếp tục thực thi tool (mặc định: true) */
  allow?: boolean;
  /** Nếu true, lập tức chặn thực thi (tương đương allow: false) */
  block?: boolean;
  /** Thông điệp giải thích lý do chặn, gửi trực tiếp về agent loop */
  message?: string;
  reason?: string;
  errorCode?: string;
  suggestion?: string;
  /** Tham số đã được chuẩn hóa / sửa đổi để tiếp tục thực thi */
  modifiedArgs?: Record<string, any>;
  advisories?: string[];
}

export type PreToolUseHookFn = (
  input: PreToolUseInput,
) => Promise<PreToolUseVerdict | void> | PreToolUseVerdict | void;

export interface PreToolUseInterceptor {
  /** Matcher: exact name ('run_command'), regex pattern ('Edit|Write'), alias ('Bash'), hoặc '*' */
  matcher?: string | RegExp;
  execute: PreToolUseHookFn;
}

export interface PreToolUseEvaluationResult {
  allowed: boolean;
  message?: string;
  errorCode?: string;
  suggestion?: string;
  modifiedArgs?: Record<string, any>;
  advisories?: string[];
}

export interface PreToolUseFileRule {
  matcher?: string;
  pattern?: string;
  action?: 'deny' | 'warn';
  message?: string;
  suggestion?: string;
}

/**
 * Kiểm tra tên tool có khớp với matcher không (hỗ trợ Claude Code aliases và pipe pattern)
 */
export function matchToolName(matcher: string | RegExp | undefined, toolName: string): boolean {
  if (!matcher || matcher === '*') return true;
  if (matcher instanceof RegExp) return matcher.test(toolName);

  const trimmed = matcher.trim();
  if (trimmed === '*' || trimmed.toLowerCase() === 'all') return true;

  const tLower = toolName.toLowerCase();

  const matchToken = (token: string): boolean => {
    const tok = token.trim().toLowerCase();
    if (!tok) return false;
    if (tok === tLower) return true;
    // Claude Code & OpenCode alias compatibility:
    if (tok === 'bash' && (tLower === 'run_command' || tLower === 'bash')) return true;
    if (tok === 'edit' && (
      tLower === 'replace_file_content' ||
      tLower === 'apply_patch' ||
      tLower === 'replace_text' ||
      tLower === 'multi_replace_file_content' ||
      tLower === 'edit'
    )) return true;
    if (tok === 'write' && (
      tLower === 'write_to_file' ||
      tLower === 'write_file' ||
      tLower === 'create_file' ||
      tLower === 'write'
    )) return true;
    if (tok === 'read' && (tLower === 'read_file' || tLower === 'read')) return true;
    if (tok === 'glob' && (tLower === 'list_files' || tLower === 'search_code_tool' || tLower === 'glob')) return true;
    if (tok === 'grep' && (tLower === 'search_text' || tLower === 'grep')) return true;

    try {
      return new RegExp(`^${token.trim()}$`, 'i').test(toolName);
    } catch {
      return false;
    }
  };

  if (trimmed.includes('|')) {
    return trimmed.split('|').some((part) => matchToken(part));
  }

  return matchToken(trimmed);
}

interface HookCacheEntry {
  at: number;
  mtimeMs: number;
  rules: PreToolUseFileRule[];
}

const CACHE = new Map<string, HookCacheEntry>();
const CACHE_TTL_MS = 30_000;

function loadFileRules(workspaceRoot?: string): PreToolUseFileRule[] {
  if (!workspaceRoot) return [];
  const key = path.resolve(workspaceRoot);
  const minusFile = path.join(key, '.minus', 'hooks.json');
  const claudeFile = path.join(key, '.claude', 'settings.json');

  let targetFile = minusFile;
  let statMtime = 0;
  try {
    const st = fs.statSync(minusFile);
    if (st.isFile()) statMtime = st.mtimeMs;
  } catch {
    try {
      const st = fs.statSync(claudeFile);
      if (st.isFile()) {
        targetFile = claudeFile;
        statMtime = st.mtimeMs;
      } else {
        return [];
      }
    } catch {
      return [];
    }
  }

  const cached = CACHE.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS && cached.mtimeMs === statMtime) {
    return cached.rules;
  }

  let rules: PreToolUseFileRule[] = [];
  try {
    const raw = fs.readFileSync(targetFile, 'utf-8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.PreToolUse)
      ? parsed.PreToolUse
      : Array.isArray(parsed?.preToolUse)
      ? parsed.preToolUse
      : Array.isArray(parsed?.hooks?.PreToolUse)
      ? parsed.hooks.PreToolUse
      : [];

    for (const r of list) {
      if (!r || typeof r !== 'object') continue;
      rules.push({
        matcher: typeof r.matcher === 'string' ? r.matcher : (typeof r.tool === 'string' ? r.tool : '*'),
        pattern: typeof r.pattern === 'string' ? r.pattern : undefined,
        action: r.action === 'warn' ? 'warn' : 'deny',
        message: typeof r.message === 'string' ? r.message : undefined,
        suggestion: typeof r.suggestion === 'string' ? r.suggestion : undefined,
      });
      if (rules.length >= 50) break;
    }
  } catch {
    rules = [];
  }

  CACHE.set(key, { at: Date.now(), mtimeMs: statMtime, rules });
  return rules;
}

export function clearPreToolUseCache(): void {
  CACHE.clear();
}

/**
 * Đánh giá danh sách interceptor hooks cho một lệnh gọi tool
 */
export async function evaluatePreToolUse(
  interceptors: PreToolUseInterceptor[],
  toolName: string,
  args: Record<string, any>,
  context?: ToolExecutionContext,
  workspaceRoot?: string,
): Promise<PreToolUseEvaluationResult> {
  let currentArgs = { ...args };
  const advisories: string[] = [];

  // 1. Kiểm tra declarative file-based rules (.minus/hooks.json hoặc .claude/settings.json)
  const fileRules = loadFileRules(workspaceRoot);
  for (const rule of fileRules) {
    if (!matchToolName(rule.matcher, toolName)) continue;

    if (rule.pattern) {
      const serialized = JSON.stringify(currentArgs);
      let re: RegExp;
      try {
        re = new RegExp(rule.pattern, 'i');
      } catch {
        continue;
      }
      if (!re.test(serialized)) continue;
    }

    if (rule.action === 'deny') {
      return {
        allowed: false,
        errorCode: 'PRE_TOOL_USE_BLOCKED',
        message: rule.message || `Tool "${toolName}" was blocked by repo hook rule.`,
        suggestion: rule.suggestion,
      };
    } else if (rule.action === 'warn') {
      if (rule.message) advisories.push(rule.message);
    }
  }

  // 2. Chạy in-memory programmatic interceptors
  for (const interceptor of interceptors) {
    if (!matchToolName(interceptor.matcher, toolName)) continue;

    try {
      const verdict = await interceptor.execute({
        toolName,
        args: currentArgs,
        context,
        workspaceRoot,
      });

      if (!verdict) continue;

      if (verdict.allow === false || verdict.block === true) {
        return {
          allowed: false,
          errorCode: verdict.errorCode || 'PRE_TOOL_USE_BLOCKED',
          message: verdict.message || verdict.reason || `Execution blocked by PreToolUse hook for tool "${toolName}".`,
          suggestion: verdict.suggestion,
        };
      }

      if (verdict.modifiedArgs && typeof verdict.modifiedArgs === 'object') {
        currentArgs = { ...currentArgs, ...verdict.modifiedArgs };
      }

      if (verdict.advisories && Array.isArray(verdict.advisories)) {
        advisories.push(...verdict.advisories);
      }
    } catch (err: any) {
      // Khi hook ném lỗi, coi như chặn lệnh (exit code 2 trong Claude Code)
      return {
        allowed: false,
        errorCode: 'PRE_TOOL_USE_BLOCKED',
        message: err?.message || `PreToolUse hook threw an error for tool "${toolName}".`,
      };
    }
  }

  const hasModifiedArgs = JSON.stringify(currentArgs) !== JSON.stringify(args);
  return {
    allowed: true,
    modifiedArgs: hasModifiedArgs ? currentArgs : undefined,
    advisories: advisories.length > 0 ? advisories : undefined,
  };
}
