import { writeFileTool } from './write-file.js';
import type { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';

/**
 * create_file compatibility alias — forwards directly to write_file.
 */
export const createFileTool: ToolDefinition = {
  ...writeFileTool,
  name: 'create_file',
  execute: async (args: Record<string, any>, workspace: Workspace = new Workspace()) => {
    return writeFileTool.execute({
      path: args.path,
      content: args.content,
      allowOverwrite: args.expectedAbsent === false,
    }, workspace);
  },
};

export default createFileTool;
