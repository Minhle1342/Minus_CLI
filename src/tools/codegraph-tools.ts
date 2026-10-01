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
    fallback: 'CodeGraph chưa sẵn sàng — dùng search_codebase_fast / grep / read_file thay thế.',
  });
}

export function createCodeGraphTools(): ToolDefinition[] {
  const codegraphExplore: ToolDefinition = {
    name: 'codegraph_explore',
    description:
      'Truy vấn semantic code graph (CodeGraph): trả về source liên quan + call paths + blast radius trong 1 call. Dùng cho "how does X work", flow X→Y, survey một khu vực. Yêu cầu project đã `codegraph init`.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Câu hỏi cấu trúc, tên symbol hoặc file (vd: "How does auth reach DB?").' },
      },
      required: ['query'],
    },
    async execute(args, workspace: Workspace) {
      const query = String(args.query || args.q || '').trim();
      if (!query) return toolError('Tham số "query" là bắt buộc.', 'INVALID_ARGS');
      const g = await guard(workspace);
      if (g.blocked) return unavailableResult(g.status);
      try {
        const output = await codeGraphClient.explore(workspace.rootDir, query);
        return toolSuccess({ available: true, query, output });
      } catch (err: any) {
        return toolError(`codegraph explore thất bại: ${err.message}`, 'EXECUTION_ERROR');
      }
    },
  };

  const codegraphNode: ToolDefinition = {
    name: 'codegraph_node',
    description: 'Đọc source + callers của 1 symbol hoặc 1 file từ CodeGraph graph (line-numbered).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        target: { type: Type.STRING, description: 'Tên symbol (vd: UserService.login) hoặc path file.' },
      },
      required: ['target'],
    },
    async execute(args, workspace: Workspace) {
      const target = String(args.target || args.symbol || args.file || '').trim();
      if (!target) return toolError('Tham số "target" là bắt buộc.', 'INVALID_ARGS');
      const g = await guard(workspace);
      if (g.blocked) return unavailableResult(g.status);
      try {
        const output = await codeGraphClient.node(workspace.rootDir, target);
        return toolSuccess({ available: true, target, output });
      } catch (err: any) {
        return toolError(`codegraph node thất bại: ${err.message}`, 'EXECUTION_ERROR');
      }
    },
  };

  const codegraphSearch: ToolDefinition = {
    name: 'codegraph_search',
    description: 'Full-text search symbol trong CodeGraph index (FTS5).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Từ khóa / tên symbol.' },
        limit: { type: Type.INTEGER, description: 'Số kết quả (1-100, mặc định 20).' },
      },
      required: ['query'],
    },
    async execute(args, workspace: Workspace) {
      const query = String(args.query || '').trim();
      if (!query) return toolError('Tham số "query" là bắt buộc.', 'INVALID_ARGS');
      const limit = args.limit === undefined ? 20 : Number(args.limit);
      const g = await guard(workspace);
      if (g.blocked) return unavailableResult(g.status);
      try {
        const result = await codeGraphClient.search(workspace.rootDir, query, limit);
        return toolSuccess({ available: true, query, limit, result });
      } catch (err: any) {
        return toolError(`codegraph search thất bại: ${err.message}`, 'EXECUTION_ERROR');
      }
    },
  };

  const codegraphCallers: ToolDefinition = {
    name: 'codegraph_callers',
    description: 'Liệt kê callers của 1 symbol từ CodeGraph (qua dynamic-dispatch hops).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        symbol: { type: Type.STRING, description: 'Tên symbol.' },
        limit: { type: Type.INTEGER, description: 'Số kết quả (mặc định 20).' },
      },
      required: ['symbol'],
    },
    async execute(args, workspace: Workspace) {
      const symbol = String(args.symbol || args.target || '').trim();
      if (!symbol) return toolError('Tham số "symbol" là bắt buộc.', 'INVALID_ARGS');
      const g = await guard(workspace);
      if (g.blocked) return unavailableResult(g.status);
      try {
        const result = await codeGraphClient.callers(workspace.rootDir, symbol, Number(args.limit || 20));
        return toolSuccess({ available: true, symbol, result });
      } catch (err: any) {
        return toolError(`codegraph callers thất bại: ${err.message}`, 'EXECUTION_ERROR');
      }
    },
  };

  const codegraphCallees: ToolDefinition = {
    name: 'codegraph_callees',
    description: 'Liệt kê callees của 1 symbol từ CodeGraph.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        symbol: { type: Type.STRING, description: 'Tên symbol.' },
        limit: { type: Type.INTEGER, description: 'Số kết quả (mặc định 20).' },
      },
      required: ['symbol'],
    },
    async execute(args, workspace: Workspace) {
      const symbol = String(args.symbol || args.target || '').trim();
      if (!symbol) return toolError('Tham số "symbol" là bắt buộc.', 'INVALID_ARGS');
      const g = await guard(workspace);
      if (g.blocked) return unavailableResult(g.status);
      try {
        const result = await codeGraphClient.callees(workspace.rootDir, symbol, Number(args.limit || 20));
        return toolSuccess({ available: true, symbol, result });
      } catch (err: any) {
        return toolError(`codegraph callees thất bại: ${err.message}`, 'EXECUTION_ERROR');
      }
    },
  };

  const codegraphImpact: ToolDefinition = {
    name: 'codegraph_impact',
    description: 'Phân tích blast radius của 1 symbol từ CodeGraph trước khi sửa.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        symbol: { type: Type.STRING, description: 'Tên symbol cần phân tích.' },
        depth: { type: Type.INTEGER, description: 'Độ sâu (mặc định 2, tối đa 5).' },
      },
      required: ['symbol'],
    },
    async execute(args, workspace: Workspace) {
      const symbol = String(args.symbol || args.target || '').trim();
      if (!symbol) return toolError('Tham số "symbol" là bắt buộc.', 'INVALID_ARGS');
      const depth = args.depth === undefined ? 2 : Math.max(1, Math.min(5, Number(args.depth)));
      const g = await guard(workspace);
      if (g.blocked) return unavailableResult(g.status);
      try {
        const result = await codeGraphClient.impact(workspace.rootDir, symbol, depth);
        return toolSuccess({ available: true, symbol, depth, result });
      } catch (err: any) {
        return toolError(`codegraph impact thất bại: ${err.message}`, 'EXECUTION_ERROR');
      }
    },
  };

  const codegraphStatus: ToolDefinition = {
    name: 'codegraph_status',
    description: 'Kiểm tra CodeGraph có cài đặt và project đã `codegraph init` hay chưa.',
    parameters: { type: Type.OBJECT, properties: {} },
    async execute(_args, workspace: Workspace) {
      try {
        const status = await codeGraphClient.status(workspace.rootDir);
        return toolSuccess({ ...status });
      } catch (err: any) {
        return toolError(`codegraph status thất bại: ${err.message}`, 'EXECUTION_ERROR');
      }
    },
  };

  return [codegraphExplore, codegraphNode, codegraphSearch, codegraphCallers, codegraphCallees, codegraphImpact, codegraphStatus];
}
