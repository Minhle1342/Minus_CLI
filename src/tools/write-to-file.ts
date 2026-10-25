import { writeFileTool } from './write-file.js';
import type { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';

/**
 * write_to_file compatibility alias — forwards directly to write_file.
 */
export const writeToFileTool: ToolDefinition = {
  ...writeFileTool,
  name: 'write_to_file',
  execute: async (args: Record<string, any>, workspace: Workspace = new Workspace()) => {
    const normalizedArgs = {
      path: args.path || args.TargetFile,
      content: args.content !== undefined ? args.content : args.CodeContent,
      allowOverwrite: args.allowOverwrite !== undefined ? args.allowOverwrite : args.Overwrite,
    };
    return writeFileTool.execute(normalizedArgs, workspace);
  },
};

export default writeToFileTool;
