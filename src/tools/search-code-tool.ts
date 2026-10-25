import { searchTextTool } from './search-text.js';
import type { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';

export function createSearchCodebaseFastTool(): ToolDefinition {
  return {
    ...searchTextTool,
    name: 'search_codebase_fast',
    execute: async (args: Record<string, any>, workspace: Workspace = new Workspace()) => {
      const filePath = args.path || (args.filePattern && !args.filePattern.includes('*') ? args.filePattern : '.');
      const include = args.include || (args.filePattern?.includes('*') ? args.filePattern : undefined);
      const res = await searchTextTool.execute({
        ...args,
        query: args.query || args.pattern || '',
        path: filePath,
        include,
      }, workspace);
      const matches = res.matches || res.results || [];
      const hits = matches.map((m: any) => {
        const rawPath = m.file || m.path || '';
        const cleanPath = rawPath.startsWith('./') ? rawPath.slice(2) : rawPath;
        return {
          path: cleanPath,
          line: m.line,
          text: m.text,
        };
      });
      return {
        ...res,
        results: matches,
        hits,
      };
    },
  };
}

export const searchCodebaseFastTool = createSearchCodebaseFastTool();
export default searchCodebaseFastTool;
