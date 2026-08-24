import type { Workspace } from '../workspace/workspace.js';
import { getOrCreateLspManager } from './lsp-manager.js';

const MUTATION_TOOLS = new Set(['write_file', 'replace_text', 'create_file', 'apply_patch', 'move_file']);

export async function enrichMutationResultWithLsp(
  toolName: string,
  args: Record<string, any>,
  result: Record<string, any>,
  workspace: Workspace,
): Promise<Record<string, any>> {
  if (!MUTATION_TOOLS.has(toolName) || isFailure(result)) return result;
  const paths = extractPaths(toolName, args, result).slice(0, 5);
  if (paths.length === 0) return result;
  const manager = getOrCreateLspManager(workspace);
  if (!manager.config.enabled && manager.config.warnings.length === 0) return result;
  try {
    const feedback = await manager.mutationFeedback(paths);
    if (!feedback.available && feedback.warnings.length === 0) return result;
    return {
      ...result,
      lsp: {
        available: feedback.available,
        providers: feedback.providers,
        diagnostics: feedback.diagnostics,
        diagnosticCount: feedback.diagnostics.length,
        warnings: feedback.warnings,
      },
    };
  } catch {
    return result;
  }
}

function extractPaths(toolName: string, args: Record<string, any>, result: Record<string, any>): string[] {
  if (toolName === 'move_file') return [String(result.targetPath || args.targetPath || '')].filter(Boolean);
  if (toolName === 'apply_patch') {
    const fromFileResults = Array.isArray(result.fileResults)
      ? result.fileResults.map((item: any) => String(item?.path || '')).filter(Boolean)
      : [];
    return [...fromFileResults, ...(Array.isArray(result.filesModified) ? result.filesModified.map(String) : []), ...(Array.isArray(result.filesCreated) ? result.filesCreated.map(String) : [])];
  }
  return [String(result.path || args.path || '')].filter(Boolean);
}

function isFailure(result: Record<string, any>): boolean {
  return result.success === false || Boolean(result.error || result.errorCode)
    || (typeof result.exitCode === 'number' && result.exitCode !== 0);
}

