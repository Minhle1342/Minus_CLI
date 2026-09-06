import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { TypeScriptService } from './typescript-service.js';
import { toolError, toolSuccess } from './tool-result.js';

let sharedTsService: TypeScriptService | undefined;

export function getOrCreateTypeScriptService(workspace: Workspace): TypeScriptService {
  if (!sharedTsService || sharedTsService['workspace'] !== workspace) {
    sharedTsService = new TypeScriptService(workspace);
  }
  return sharedTsService;
}

/**
 * Tool inspect_symbol
 * 
 * Tra cứu định nghĩa, kiểu dữ liệu (type signature), thuộc tính export và chú thích của một symbol trong codebase.
 */
export const inspectSymbolTool: ToolDefinition = {
  name: 'inspect_symbol',
  description: 'Lookup semantic symbol info (definition, type signature, kind, export status, doc comment) using the TypeScript Language Service.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: 'File path containing or importing the symbol (e.g. "src/services/user-service.ts"). Alias: "filePath".',
      },
      filePath: {
        type: Type.STRING,
        description: 'Alias for "path": File path containing or importing the symbol.',
      },
      symbol: {
        type: Type.STRING,
        description: 'Symbol name to look up (e.g. "findUser" or "AgentLoop"). Alias: "symbolName".',
      },
      symbolName: {
        type: Type.STRING,
        description: 'Alias for "symbol": Symbol name to look up.',
      },
    },
    required: [],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const rawPath = String(args.path || args.filePath || '').trim();
    let symbol = String(args.symbol || args.symbolName || '').trim();

    if (!symbol && rawPath) {
      const baseName = rawPath.split(/[/\\]/).pop() || '';
      const dotIndex = baseName.lastIndexOf('.');
      symbol = dotIndex > 0 ? baseName.substring(0, dotIndex) : baseName;
    }

    if (!rawPath || !symbol) {
      return toolError('Both "path" (or "filePath") and "symbol" (or "symbolName") parameters are required.', 'INVALID_ARGS');
    }

    try {
      const tsService = getOrCreateTypeScriptService(workspace);
      const res = tsService.inspectSymbol(rawPath, symbol);

      if (!res.found) {
        return toolError(
          `Symbol definition "${symbol}" was not found in file "${rawPath}".`,
          'FILE_NOT_FOUND',
          { path: rawPath, symbol },
          'Check the symbol name or use search_text/read_file to locate the symbol definition.',
        );
      }

      return toolSuccess(res);
    } catch (err: any) {
      return toolError(`Error inspecting symbol: ${err.message}`, 'EXECUTION_ERROR');
    }
  },
};
