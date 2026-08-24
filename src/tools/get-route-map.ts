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

export function createGetRouteMapTool(service?: CodebaseIntelligenceService): ToolDefinition {
  return {
    name: 'get_route_map',
    description: 'Tự động quét và bóc tách toàn bộ API Routes & Endpoints trong workspace (hỗ trợ Express, Next.js App Router, Fastify, Hono, NestJS, FastAPI). Trả về HTTP Method, Route Path, Controller Handler và Middlewares.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        pathPattern: {
          type: Type.STRING,
          description: 'Mẫu regex/chuỗi để lọc URL path (ví dụ: "^/api/v1", "auth", "users").',
        },
        framework: {
          type: Type.STRING,
          description: 'Lọc framework cụ thể: "express", "nextjs", "nestjs", "fastify", "hono", hoặc "auto" (mặc định "auto").',
        },
      },
      required: [],
    },
    async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
      const pathPattern = args.pathPattern ? String(args.pathPattern).trim() : undefined;
      const framework = args.framework ? String(args.framework).trim() : undefined;

      const engine = service || getIntelligenceService(workspace);
      const routes = engine.getRouteMap(pathPattern, framework);

      return {
        success: true,
        count: routes.length,
        routes,
      };
    },
  };
}

export const getRouteMapTool = createGetRouteMapTool();
