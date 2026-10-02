import { Type } from "@google/genai";
import { ToolDefinition } from "./types.js";
import { Workspace } from "../workspace/workspace.js";
import { CodebaseIntelligenceService } from "./codebase-intelligence.js";

let sharedIntelligenceService: CodebaseIntelligenceService | undefined;

export function getIntelligenceService(
  workspace: Workspace,
): CodebaseIntelligenceService {
  if (!sharedIntelligenceService) {
    sharedIntelligenceService = new CodebaseIntelligenceService(workspace);
  }
  return sharedIntelligenceService;
}

export function createGetArchitectureTopologyTool(
  service?: CodebaseIntelligenceService,
): ToolDefinition {
  return {
    name: "get_architecture_topology",
    description:
      "Analyze the layered architecture & topology map of the codebase (Controllers, Services, Repositories, UI, Tools, Config, Utils, Tests). " +
      "Use the TypeScript Compiler AST & Module Resolution to resolve import paths precisely (including tsconfig paths aliases). " +
      "Automatically detect Circular Dependencies, Clean Architecture layer violations, and compute Robert C. Martin coupling metrics (Afferent/Efferent coupling, Instability, Hub nodes). " +
      'Supports the mode parameter ("summary" | "detailed" | "full") to optimize the LLM token context window. ' +
      "Supports pagination for layers/files (maxLayers, maxFilesPerLayer) and returns a truncated flag when cut.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        entryDir: {
          type: Type.STRING,
          description:
            'Root directory to start the topo scan (default "src" or ".").',
        },
        mode: {
          type: Type.STRING,
          description:
            "Result display mode for token optimization: " +
            '"summary" (default - returns layer counts, instability metrics, top hub nodes, cycle loops and layer violations; saves >90% tokens), ' +
            '"detailed" (includes the concrete file list per layer), ' +
            '"full" (returns the full raw dependencyGraph matrix of all files).',
          enum: ["summary", "detailed", "full"],
        },
        focusLayer: {
          type: Type.STRING,
          description:
            'Optionally filter to a single architecture layer (e.g. "controller", "service", "repository", "ui", "tools", "utils", "config", "test").',
          enum: [
            "controller",
            "service",
            "repository",
            "ui",
            "tools",
            "utils",
            "config",
            "test",
            "other",
          ],
        },
        forceRefresh: {
          type: Type.BOOLEAN,
          description:
            "Skip the 30s cache and rescan everything from disk (default false).",
        },
        maxLayers: {
          type: Type.INTEGER,
          description:
            "Maximum number of architecture layers returned (default: all). Used for pagination.",
        },
        maxFilesPerLayer: {
          type: Type.INTEGER,
          description:
            "Maximum files per layer (default: 100). Used for pagination.",
        },
      },
      required: [],
    },
    async execute(
      args: Record<string, any>,
      workspace: Workspace,
    ): Promise<Record<string, any>> {
      const entryDir = args.entryDir ? String(args.entryDir).trim() : "src";
      const mode = (args.mode as "summary" | "detailed" | "full") || "summary";
      const focusLayer = args.focusLayer
        ? String(args.focusLayer).trim()
        : undefined;
      const forceRefresh = Boolean(args.forceRefresh);
      const maxLayers = args.maxLayers !== undefined ? Math.max(1, Number(args.maxLayers) || 1) : undefined;
      const maxFilesPerLayer = args.maxFilesPerLayer !== undefined
        ? Math.max(1, Number(args.maxFilesPerLayer) || 100)
        : 100;

      const engine = service || getIntelligenceService(workspace);
      const rawTopology = engine.getArchitectureTopology(entryDir, {
        mode,
        focusLayer,
        forceRefresh,
      });

      // Lọc theo focusLayer nếu có
      let layers = rawTopology.layers;
      if (focusLayer && layers[focusLayer]) {
        layers = { [focusLayer]: layers[focusLayer] };
      }

      // Apply pagination caps
      let layersTotal = Object.keys(layers).length;
      let filesTotal = 0;
      for (const layer of Object.values(layers)) {
        filesTotal += layer.files.length;
      }
      let truncated = false;

      if (maxLayers || maxFilesPerLayer < Infinity) {
        const layerKeys = Object.keys(layers);
        const limitedLayers: typeof layers = {};
        let layerCount = 0;
        for (const key of layerKeys) {
          if (maxLayers && layerCount >= maxLayers) {
            truncated = true;
            break;
          }
          const layer = layers[key];
          if (maxFilesPerLayer && layer.files.length > maxFilesPerLayer) {
            limitedLayers[key] = {
              ...layer,
              files: layer.files.slice(0, maxFilesPerLayer),
            };
            truncated = true;
          } else {
            limitedLayers[key] = layer;
          }
          layerCount++;
        }
        layers = limitedLayers;
      }

      let layersReturned = Object.keys(layers).length;
      let filesReturned = 0;
      for (const layer of Object.values(layers)) {
        filesReturned += layer.files.length;
      }

      // Xây dựng response phù hợp với mode theo nguyên lý Tool Design
      if (mode === "summary") {
        const layerSummaries: Record<
          string,
          { name: string; fileCount: number }
        > = {};
        for (const [key, layer] of Object.entries(layers)) {
          layerSummaries[key] = {
            name: layer.name,
            fileCount: layer.files.length,
          };
        }

        return {
          success: true,
          mode: "summary",
          topology: {
            totalFiles: rawTopology.totalFiles,
            totalDependencies: rawTopology.totalDependencies,
            layers,
            circularCycles: rawTopology.circularCycles,
            layerViolations: rawTopology.layerViolations,
            metrics: rawTopology.metrics,
          },
          summary: {
            layerDistribution: layerSummaries,
            circularCycleCount: rawTopology.circularCycles.length,
            layerViolationCount: rawTopology.layerViolations.length,
            averageInstability: rawTopology.metrics?.averageInstability,
            topHubs: rawTopology.metrics?.hubNodes.slice(0, 3),
          },
          pagination: {
            layersTotal,
            layersReturned,
            filesTotal,
            filesReturned,
            truncated,
          },
          hint: 'To see detailed file lists per layer, use mode="detailed". To retrieve the full raw dependency graph, use mode="full". Use maxLayers/maxFilesPerLayer for pagination.',
        };
      }

      if (mode === "detailed") {
        return {
          success: true,
          mode: "detailed",
          topology: {
            totalFiles: rawTopology.totalFiles,
            totalDependencies: rawTopology.totalDependencies,
            layers,
            circularCycles: rawTopology.circularCycles,
            layerViolations: rawTopology.layerViolations,
            metrics: rawTopology.metrics,
          },
          pagination: {
            layersTotal,
            layersReturned,
            filesTotal,
            filesReturned,
            truncated,
          },
        };
      }

      // mode === 'full'
      return {
        success: true,
        mode: "full",
        topology: {
          ...rawTopology,
          layers,
        },
        pagination: {
          layersTotal,
          layersReturned,
          filesTotal,
          filesReturned,
          truncated,
        },
      };
    },
  };
}

export const getArchitectureTopologyTool = createGetArchitectureTopologyTool();
