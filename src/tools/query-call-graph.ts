import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { CodebaseIntelligenceService } from './codebase-intelligence.js';

let sharedIntelligenceService: CodebaseIntelligenceService | undefined;

function getIntelligenceService(workspace: Workspace): CodebaseIntelligenceService {
  if (!sharedIntelligenceService) {
    sharedIntelligenceService = new CodebaseIntelligenceService(workspace);
  }
  return sharedIntelligenceService;
}

export function createQueryCallGraphTool(service?: CodebaseIntelligenceService): ToolDefinition {
  return {
    name: 'query_call_graph',
    description: 'Query the 2-way function call graph (Call Graph & Call Hierarchy) — Callers: which functions call it, Callees: which functions it calls — at a custom depth. Helps the LLM grasp the execution flow in 1 step.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        symbolName: {
          type: Type.STRING,
          description: 'Name of the function, method, or class whose call flow should be traced (e.g. "submitSolution", "Tower"). Alias "symbol" may be used.',
        },
        symbol: {
          type: Type.STRING,
          description: 'Alias for "symbolName": name of the function, method, or class whose call flow should be traced.',
        },
        filePath: {
          type: Type.STRING,
          description: 'Path of the file defining the symbol (e.g. "Assets/_Project/Scripts/Combat/Tower.cs"). Alias "path" may be used.',
        },
        path: {
          type: Type.STRING,
          description: 'Alias for "filePath": path of the file defining the symbol.',
        },
        direction: {
          type: Type.STRING,
          enum: ['callers', 'callees', 'both'],
          description: 'Analysis direction: "callers" (parent functions calling it), "callees" (child functions it calls), or "both" (default "both").',
        },
        depth: {
          type: Type.INTEGER,
          description: 'Depth of the call-hierarchy tree to expand (default 2, max 5).',
        },
        pruneNoise: {
          type: Type.BOOLEAN,
          description: 'Prune ubiquitous utility functions (log, toString, etc.) per the CoSIL standard to reduce noise (default true).',
        },
      },
      required: [],
    },
    async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
      let symbolName = String(args.symbolName || args.symbol || '').trim();
      const rawPath = String(args.filePath || args.path || '').trim();
      const filePath = rawPath || undefined;

      // Tự động suy luận symbol từ tên file nếu không truyền symbolName (vd: Tower.cs -> Tower)
      if (!symbolName && filePath) {
        const baseName = filePath.split(/[/\\]/).pop() || '';
        const dotIndex = baseName.lastIndexOf('.');
        symbolName = dotIndex > 0 ? baseName.substring(0, dotIndex) : baseName;
      }

      if (!symbolName) {
        return {
          error: 'The "symbolName" or "symbol" parameter is required.',
          errorCode: 'INVALID_ARGS',
          suggestion: 'Provide a function/class name or the file path defining the symbol (e.g. { symbol: "Tower", path: "Assets/_Project/Scripts/Combat/Tower.cs" }).',
        };
      }

      const direction = (args.direction === 'callers' || args.direction === 'callees' ? args.direction : 'both') as 'callers' | 'callees' | 'both';
      const depth = typeof args.depth === 'number' ? args.depth : 2;
      const pruneNoise = args.pruneNoise !== false;

      const engine = service || getIntelligenceService(workspace);
      const result = engine.queryCallGraph(symbolName, filePath, direction, depth, { pruneNoise });

      return {
        success: true,
        callGraph: result,
      };
    },
  };
}

export const queryCallGraphTool = createQueryCallGraphTool();
