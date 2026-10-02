import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { CodebaseIntelligenceService } from './codebase-intelligence.js';

const intelligenceServicesByWorkspace = new WeakMap<Workspace, CodebaseIntelligenceService>();

function getIntelligenceService(workspace: Workspace): CodebaseIntelligenceService {
  const existing = intelligenceServicesByWorkspace.get(workspace);
  if (existing) return existing;
  const service = new CodebaseIntelligenceService(workspace);
  intelligenceServicesByWorkspace.set(workspace, service);
  return service;
}

export function createGetSymbolContext360Tool(service?: CodebaseIntelligenceService): ToolDefinition {
  return {
    name: 'get_symbol_context_360',
    description: 'Provide a 360-degree view of a symbol in a single payload: definition, type signature, doc comments, callers (who calls it), callees (who it calls), dependent imports, referencing files and related test files.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        symbol: {
          type: Type.STRING,
          description: 'Name of the symbol to get the 360-degree context for (function, class, interface, type, variable). Alias symbolName may be used.',
        },
        symbolName: {
          type: Type.STRING,
          description: 'Alias for symbol: name of the symbol to look up.',
        },
        path: {
          type: Type.STRING,
          description: 'Relative path to the file hinting where the symbol is defined. Alias filePath may be used.',
        },
        filePath: {
          type: Type.STRING,
          description: 'Alias for path: hint file path.',
        },
      },
      required: [],
    },
    async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
      const symbolName = String(args.symbol || args.symbolName || '').trim();
      if (!symbolName) {
        return { error: 'The "symbol" (or "symbolName") parameter is required.' };
      }

      const filePath = String(args.path || args.filePath || '').trim() || undefined;
      const engine = service || getIntelligenceService(workspace);
      const result = engine.getSymbolContext360(symbolName, filePath);

      return {
        success: true,
        context360: result,
      };
    },
  };
}

export const getSymbolContext360Tool = createGetSymbolContext360Tool();
