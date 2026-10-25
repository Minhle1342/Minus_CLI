import { replaceTextTool } from './replace-text.js';
import type { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';

/**
 * replace_file_content compatibility alias — forwards directly to replace_text.
 */
export const replaceFileContentTool: ToolDefinition = {
  ...replaceTextTool,
  name: 'replace_file_content',
  execute: async (args: Record<string, any>, workspace: Workspace = new Workspace()) => {
    const normalizedArgs = {
      path: args.path || args.TargetFile,
      oldText: args.oldText !== undefined ? args.oldText : args.TargetContent,
      newText: args.newText !== undefined ? args.newText : args.ReplacementContent,
      multiple: args.multiple !== undefined ? args.multiple : args.AllowMultiple,
    };
    return replaceTextTool.execute(normalizedArgs, workspace);
  },
};

export default replaceFileContentTool;
