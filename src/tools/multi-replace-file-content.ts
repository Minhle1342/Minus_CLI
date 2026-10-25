import fs from 'node:fs/promises';
import { createPatch } from 'diff';
import { replaceTextTool } from './replace-text.js';
import type { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { toolError } from './tool-result.js';

/**
 * multi_replace_file_content compatibility alias — forwards sequentially to replace_text.
 */
export const multiReplaceFileContentTool: ToolDefinition = {
  ...replaceTextTool,
  name: 'multi_replace_file_content',
  execute: async (args: Record<string, any>, workspace: Workspace = new Workspace()) => {
    const filePath = args.path || args.TargetFile;
    if (!filePath) {
      return toolError('Parameter "TargetFile" (or "path") is required.', 'INVALID_ARGS');
    }
    const chunks = args.ReplacementChunks || [];
    if (!Array.isArray(chunks) || chunks.length === 0) {
      return toolError('ReplacementChunks must be a non-empty array.', 'INVALID_ARGS');
    }
    let safePath = filePath;
    try {
      safePath = workspace.resolveSafePath(filePath);
    } catch {}
    const beforeContent = await fs.readFile(safePath, 'utf8').catch(() => '');

    let lastResult: any = null;
    for (const chunk of chunks) {
      const res = await replaceTextTool.execute({
        path: filePath,
        oldText: chunk.TargetContent ?? chunk.oldText,
        newText: chunk.ReplacementContent ?? chunk.newText,
        multiple: chunk.AllowMultiple ?? chunk.multiple ?? false,
      }, workspace);
      if (res && res.error) {
        return res;
      }
      lastResult = res;
    }

    const afterContent = await fs.readFile(safePath, 'utf8').catch(() => '');
    const unifiedDiff = createPatch(filePath, beforeContent, afterContent, 'before', 'after');

    return { ...(lastResult || { success: true }), unifiedDiff };
  },
};

export default multiReplaceFileContentTool;
