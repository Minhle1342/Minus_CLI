import { Type } from '@google/genai';
import type { ToolDefinition } from './types.js';
import type { Workspace } from '../workspace/workspace.js';
import { getOrCreateLspManager } from '../lsp/lsp-manager.js';
import type { LspOperation } from '../lsp/types.js';
import { toolError, toolSuccess } from './tool-result.js';

const OPERATIONS: LspOperation[] = [
  'hover', 'definition', 'references', 'documentSymbol', 'workspaceSymbol',
  'implementation', 'prepareCallHierarchy', 'incomingCalls', 'outgoingCalls',
];

export const lspQueryTool: ToolDefinition = {
  name: 'lsp_query',
  description: 'Query configured multi-language LSP servers for hover, definition, references, symbols, implementations, call hierarchy, or runtime status. Positions are 1-based.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      operation: {
        type: Type.STRING,
        enum: [...OPERATIONS, 'status'],
        description: 'LSP operation to execute, or status to inspect configured/running servers.',
      },
      path: {
        type: Type.STRING,
        description: 'Workspace-relative file used to select the language server. Required except for status.',
      },
      line: { type: Type.INTEGER, description: '1-based line. Required for position-based operations.' },
      character: { type: Type.INTEGER, description: '1-based character. Required for position-based operations.' },
      query: { type: Type.STRING, description: 'Workspace symbol query string (workspaceSymbol only).' },
    },
    required: ['operation'],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const operation = String(args.operation || '');
    const manager = getOrCreateLspManager(workspace);
    if (operation === 'status') {
      return toolSuccess({ enabled: manager.config.enabled, configPath: manager.config.configPath, warnings: manager.config.warnings, servers: manager.status() });
    }
    if (!OPERATIONS.includes(operation as LspOperation)) return toolError(`Unsupported LSP operation: ${operation}`, 'INVALID_ARGS');
    const filePath = String(args.path || '').trim();
    if (!filePath) return toolError('"path" is required for LSP queries.', 'INVALID_ARGS');
    const positionless = operation === 'documentSymbol' || operation === 'workspaceSymbol';
    if (!positionless && (!Number.isInteger(args.line) || args.line < 1 || !Number.isInteger(args.character) || args.character < 1)) {
      return toolError('"line" and "character" must be positive 1-based integers for this operation.', 'INVALID_ARGS');
    }
    try {
      const result = await manager.query({
        operation: operation as LspOperation,
        filePath,
        position: { line: Math.max(0, Number(args.line || 1) - 1), character: Math.max(0, Number(args.character || 1) - 1) },
        query: String(args.query || ''),
      });
      return toolSuccess(result);
    } catch (error: any) {
      return toolError(`LSP query failed: ${error.message}`, 'EXECUTION_ERROR', { operation, path: filePath });
    }
  },
};

