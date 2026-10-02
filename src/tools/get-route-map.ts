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
    description: 'Automatically scan and extract all API Routes & Endpoints in the workspace (supports Express, Next.js App Router, Fastify, Hono, NestJS, FastAPI). Returns HTTP Method, Route Path, Controller Handler and Middlewares.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        pathPattern: {
          type: Type.STRING,
          description: 'Regex/string pattern to filter URL paths (e.g. "^/api/v1", "auth", "users").',
        },
        framework: {
          type: Type.STRING,
          description: 'Filter by a specific framework: "express", "nextjs", "nestjs", "fastify", "hono", or "auto" (default "auto").',
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
