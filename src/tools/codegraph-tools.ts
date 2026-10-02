import { Type } from '@google/genai';
import type { ToolDefinition } from './types.js';
import type { Workspace } from '../workspace/workspace.js';
import { toolError, toolSuccess } from './tool-result.js';
import { codeGraphClient } from '../search/codegraph-client.js';

async function guard(workspace: Workspace) {
  const status = await codeGraphClient.status(workspace.rootDir);
  if (!status.available) {
    return { blocked: true as const, status };
  }
  if (!status.indexed) {
    return { blocked: true as const, status };
  }
  return { blocked: false as const, status };
}

function unavailableResult(status: Awaited<ReturnType<typeof codeGraphClient.status>>) {
  return toolSuccess({
    available: false,
    indexed: status.indexed,
    hint: status.hint,
    fallback: 'CodeGraph is not ready — use search_codebase_fast / grep / read_file instead.',
  });
}

export function createCodeGraphTools(): ToolDefinition[] {
  const codegraphExplore: ToolDefinition = {
    name: 'codegraph_explore',
    description:
      'Query the semantic code graph (CodeGraph): returns related source + call paths + blast radius in 1 call. Use for "how does X work", flow X→Y, or surveying an area. Requires the project to have run `codegraph init`.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Structured question, symbol name or file (e.g. "How does auth reach DB?").' },
      },
      required: ['query'],
    },
    async execute(args, workspace: Workspace) {
      const query = String(args.query || args.q || '').trim();
      if (!query) return toolError('The "query" parameter is required.', 'INVALID_ARGS');
      const g = await guard(workspace);
      if (g.blocked) return unavailableResult(g.status);
      try {
        const output = await codeGraphClient.explore(workspace.rootDir, query);
        return toolSuccess({ available: true, query, output });
      } catch (err: any) {
        return toolError(`codegraph explore failed: ${err.message}`, 'EXECUTION_ERROR');
      }
    },
  };

  const codegraphNode: ToolDefinition = {
    name: 'codegraph_node',
    description: 'Read the source + callers of 1 symbol or 1 file from the CodeGraph graph (line-numbered).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        target: { type: Type.STRING, description: 'Symbol name (e.g. UserService.login) or file path.' },
      },
      required: ['target'],
    },
    async execute(args, workspace: Workspace) {
      const target = String(args.target || args.symbol || args.file || '').trim();
      if (!target) return toolError('The "target" parameter is required.', 'INVALID_ARGS');
      const g = await guard(workspace);
      if (g.blocked) return unavailableResult(g.status);
      try {
        const output = await codeGraphClient.node(workspace.rootDir, target);
        return toolSuccess({ available: true, target, output });
      } catch (err: any) {
        return toolError(`codegraph node failed: ${err.message}`, 'EXECUTION_ERROR');
      }
    },
  };

  const codegraphSearch: ToolDefinition = {
    name: 'codegraph_search',
    description: 'Full-text symbol search in the CodeGraph index (FTS5).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Keyword / symbol name.' },
        limit: { type: Type.INTEGER, description: 'Number of results (1-100, default 20).' },
      },
      required: ['query'],
    },
    async execute(args, workspace: Workspace) {
      const query = String(args.query || '').trim();
      if (!query) return toolError('The "query" parameter is required.', 'INVALID_ARGS');
      const limit = args.limit === undefined ? 20 : Number(args.limit);
      const g = await guard(workspace);
      if (g.blocked) return unavailableResult(g.status);
      try {
        const result = await codeGraphClient.search(workspace.rootDir, query, limit);
        return toolSuccess({ available: true, query, limit, result });
      } catch (err: any) {
        return toolError(`codegraph search failed: ${err.message}`, 'EXECUTION_ERROR');
      }
    },
  };

  const codegraphCallers: ToolDefinition = {
    name: 'codegraph_callers',
    description: 'List callers of 1 symbol from CodeGraph (via dynamic-dispatch hops).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        symbol: { type: Type.STRING, description: 'Symbol name.' },
        limit: { type: Type.INTEGER, description: 'Number of results (default 20).' },
      },
      required: ['symbol'],
    },
    async execute(args, workspace: Workspace) {
      const symbol = String(args.symbol || args.target || '').trim();
      if (!symbol) return toolError('The "symbol" parameter is required.', 'INVALID_ARGS');
      const g = await guard(workspace);
      if (g.blocked) return unavailableResult(g.status);
      try {
        const result = await codeGraphClient.callers(workspace.rootDir, symbol, Number(args.limit || 20));
        return toolSuccess({ available: true, symbol, result });
      } catch (err: any) {
        return toolError(`codegraph callers failed: ${err.message}`, 'EXECUTION_ERROR');
      }
    },
  };

  const codegraphCallees: ToolDefinition = {
    name: 'codegraph_callees',
    description: 'List callees of 1 symbol from CodeGraph.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        symbol: { type: Type.STRING, description: 'Symbol name.' },
        limit: { type: Type.INTEGER, description: 'Number of results (default 20).' },
      },
      required: ['symbol'],
    },
    async execute(args, workspace: Workspace) {
      const symbol = String(args.symbol || args.target || '').trim();
      if (!symbol) return toolError('The "symbol" parameter is required.', 'INVALID_ARGS');
      const g = await guard(workspace);
      if (g.blocked) return unavailableResult(g.status);
      try {
        const result = await codeGraphClient.callees(workspace.rootDir, symbol, Number(args.limit || 20));
        return toolSuccess({ available: true, symbol, result });
      } catch (err: any) {
        return toolError(`codegraph callees failed: ${err.message}`, 'EXECUTION_ERROR');
      }
    },
  };

  const codegraphImpact: ToolDefinition = {
    name: 'codegraph_impact',
    description: 'Analyze the blast radius of 1 symbol from CodeGraph before editing.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        symbol: { type: Type.STRING, description: 'Name of the symbol to analyze.' },
        depth: { type: Type.INTEGER, description: 'Depth (default 2, max 5).' },
      },
      required: ['symbol'],
    },
    async execute(args, workspace: Workspace) {
      const symbol = String(args.symbol || args.target || '').trim();
      if (!symbol) return toolError('The "symbol" parameter is required.', 'INVALID_ARGS');
      const depth = args.depth === undefined ? 2 : Math.max(1, Math.min(5, Number(args.depth)));
      const g = await guard(workspace);
      if (g.blocked) return unavailableResult(g.status);
      try {
        const result = await codeGraphClient.impact(workspace.rootDir, symbol, depth);
        return toolSuccess({ available: true, symbol, depth, result });
      } catch (err: any) {
        return toolError(`codegraph impact failed: ${err.message}`, 'EXECUTION_ERROR');
      }
    },
  };

  const codegraphStatus: ToolDefinition = {
    name: 'codegraph_status',
    description: 'Check whether CodeGraph is installed and the project has run `codegraph init`.',
    parameters: { type: Type.OBJECT, properties: {} },
    async execute(_args, workspace: Workspace) {
      try {
        const status = await codeGraphClient.status(workspace.rootDir);
        return toolSuccess({ ...status });
      } catch (err: any) {
        return toolError(`codegraph status failed: ${err.message}`, 'EXECUTION_ERROR');
      }
    },
  };

  return [codegraphExplore, codegraphNode, codegraphSearch, codegraphCallers, codegraphCallees, codegraphImpact, codegraphStatus];
}
