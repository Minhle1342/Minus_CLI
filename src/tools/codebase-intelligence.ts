import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../workspace/workspace.js';
import { TypeScriptService } from './typescript-service.js';

export interface CallNode {
  name: string;
  file: string;
  line: number;
  kind?: string;
  children?: CallNode[];
  depth?: number;
  relevance?: 'high' | 'utility';
  isPruned?: boolean;
}

export interface CallGraphResult {
  symbol: string;
  file?: string;
  line?: number;
  direction: 'callers' | 'callees' | 'both';
  callees: CallNode[];
  callers: CallNode[];
  prunedCount?: number;
}

export const UTILITY_NOISE_SYMBOLS = new Set([
  'log', 'info', 'warn', 'error', 'debug', 'trace',
  'toString', 'valueOf', 'toJSON', 'format',
  'trim', 'split', 'join', 'map', 'filter', 'forEach', 'reduce',
  'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'concat',
  'get', 'set', 'hasOwnProperty', 'includes', 'indexOf',
  'resolve', 'reject', 'then', 'catch', 'finally',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
]);

export function isUtilityNoiseSymbol(name: string): boolean {
  if (!name) return false;
  const clean = name.replace(/^[#_]+/, '');
  return UTILITY_NOISE_SYMBOLS.has(clean) || UTILITY_NOISE_SYMBOLS.has(name);
}

export interface RouteEntry {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'USE' | 'ALL' | 'WS';
  path: string;
  file: string;
  line: number;
  handler: string;
  middlewares?: string[];
  framework?: string;
}

export interface SymbolContext360Result {
  symbol: string;
  kind?: string;
  file?: string;
  line?: number;
  typeSignature?: string;
  docComment?: string;
  isExported?: boolean;
  callers: Array<{ name: string; file: string; line: number }>;
  callees: Array<{ name: string; file: string; line: number }>;
  importedDependencies: string[];
  referencingFiles: string[];
  relatedTests: Array<{ file: string; line: number; preview: string }>;
}

export type ArchitectureLayerKey =
  | 'controller'
  | 'service'
  | 'repository'
  | 'ui'
  | 'tools'
  | 'utils'
  | 'config'
  | 'test'
  | 'other';

export interface ArchitectureLayer {
  name: string;
  description: string;
  files: string[];
}

export interface CircularDependencyCycle {
  cycle: string[];
  length: number;
}

export interface LayerViolation {
  from: string;
  to: string;
  fromLayer: string;
  toLayer: string;
  rule: string;
}

export interface NodeCouplingMetric {
  file: string;
  afferentCoupling: number;
  efferentCoupling: number;
  instability: number;
}

export interface ArchitectureMetricsSummary {
  averageInstability: number;
  hubNodes: NodeCouplingMetric[];
  mostStableModules: NodeCouplingMetric[];
  mostUnstableModules: NodeCouplingMetric[];
}

export interface ArchitectureTopologyOptions {
  mode?: 'summary' | 'detailed' | 'full';
  focusLayer?: string;
  forceRefresh?: boolean;
}

export interface ArchitectureTopologyResult {
  totalFiles: number;
  totalDependencies: number;
  layers: Record<string, ArchitectureLayer>;
  dependencyGraph: Record<string, string[]>;
  circularCycles: CircularDependencyCycle[];
  layerViolations: LayerViolation[];
  metrics?: ArchitectureMetricsSummary;
}

/**
 * CodebaseIntelligenceService
 * 
 * Động cơ phân tích đồ thị tri thức mã nguồn (Code Knowledge Graph Engine)
 * cung cấp:
 * 1. Call Graph (Truy vết chuỗi gọi hàm đa cấp 2 chiều Callers/Callees).
 * 2. Route Map (Tự động phát hiện toàn bộ API Endpoints và Router).
 * 3. Symbol Context 360 (Toàn cảnh 360 độ về một symbol).
 * 4. Architecture Topology & Circular Dependency Analysis (Bản đồ phân tầng và phát hiện phụ thuộc vòng).
 */
export class CodebaseIntelligenceService {
  private tsService: TypeScriptService;
  private workspace: Workspace;
  private cachedTopology?: {
    entryDir: string;
    timestamp: number;
    result: ArchitectureTopologyResult;
  };

  constructor(workspace: Workspace, tsService?: TypeScriptService) {
    this.workspace = workspace;
    this.tsService = tsService || new TypeScriptService(workspace);
  }

  invalidateTopologyCache(): void {
    this.cachedTopology = undefined;
  }

  getTypeScriptService(): TypeScriptService {
    return this.tsService;
  }

  /**
   * 1. Xây dựng Call Graph 2 chiều (Callers & Callees) với độ sâu tùy chỉnh
   * Tích hợp CoSIL Relevance Pruning (arXiv:2503.22424v3) & Bounded Subgraph (RepoGraph arXiv:2410.14684v2)
   */
  queryCallGraph(
    symbolName: string,
    filePath?: string,
    direction: 'callers' | 'callees' | 'both' = 'both',
    maxDepth: number = 2,
    options?: { pruneNoise?: boolean },
  ): CallGraphResult {
    this.tsService.syncWorkspaceFiles();
    const cleanSymbol = symbolName.trim();
    const depth = Math.min(Math.max(1, maxDepth), 5);
    const pruneNoise = options?.pruneNoise ?? true;
    let prunedCount = 0;

    const callees: CallNode[] = [];
    const callers: CallNode[] = [];

    let targetFile = filePath;
    let targetLine: number | undefined;

    // Tìm vị trí định nghĩa symbol nếu chưa có filePath
    if (!targetFile) {
      const inspect = this.findSymbolDefinitionAcrossWorkspace(cleanSymbol);
      if (inspect?.file) {
        targetFile = inspect.file;
        targetLine = inspect.line;
      }
    }

    const visitedCallees = new Set<string>([cleanSymbol]);
    const visitedCallers = new Set<string>([cleanSymbol]);

    if (direction === 'callees' || direction === 'both') {
      if (targetFile) {
        const found = this.extractCallees(cleanSymbol, targetFile, depth, pruneNoise, visitedCallees);
        callees.push(...found.nodes);
        prunedCount += found.prunedCount;
      }
    }

    if (direction === 'callers' || direction === 'both') {
      const found = this.extractCallers(cleanSymbol, depth, pruneNoise, visitedCallers);
      callers.push(...found.nodes);
      prunedCount += found.prunedCount;
    }

    return {
      symbol: cleanSymbol,
      file: targetFile ? this.workspace.toRelativePath(targetFile) : undefined,
      line: targetLine,
      direction,
      callees,
      callers,
      prunedCount,
    };
  }

  /**
   * 2. Bóc tách Route Map toàn workspace (Express, Fastify, Next.js, Hono, NestJS...)
   */
  getRouteMap(pathPattern?: string, frameworkFilter?: string): RouteEntry[] {
    this.tsService.syncWorkspaceFiles();
    const routes: RouteEntry[] = [];
    const scannedFiles = this.getAllCodeFiles();

    for (const file of scannedFiles) {
      const content = this.safeReadFile(file);
      if (!content) continue;

      const relPath = this.workspace.toRelativePath(file);

      // 2a. Next.js App Router (app/**/route.ts hoặc app/**/page.tsx)
      if (file.includes(path.join('app', '')) || file.includes('app/')) {
        const routeMatch = file.match(/[\\/]app[\\/](.*?)[\\/](route|page)\.(ts|js|tsx|jsx)$/);
        if (routeMatch) {
          const routeSubPath = '/' + routeMatch[1].replace(/\\/g, '/').replace(/\[(.*?)\]/g, ':$1');
          const lines = content.split('\n');
          const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'];
          for (const method of methods) {
            const regex = new RegExp(`export\\s+(async\\s+)?function\\s+${method}\\b`);
            const lineIdx = lines.findIndex((l) => regex.test(l));
            if (lineIdx !== -1) {
              routes.push({
                method: method as any,
                path: routeSubPath || '/',
                file: relPath,
                line: lineIdx + 1,
                handler: method,
                framework: 'Next.js App Router',
              });
            }
          }
        }
      }

      // 2b. Express / Fastify / Hono / Router AST / Regex Analysis
      const expressMethodRegex = /(?:app|router|server)\.(get|post|put|delete|patch|use|all)\s*\(\s*(['"`])([^'"`]+)\2\s*(?:,\s*([^,\n\)]+))*/gi;
      let match: RegExpExecArray | null;
      while ((match = expressMethodRegex.exec(content)) !== null) {
        const httpMethod = match[1].toUpperCase() as RouteEntry['method'];
        const routePath = match[3];
        const handlerName = match[4]?.trim() || 'anonymousHandler';
        const line = content.slice(0, match.index).split('\n').length;

        // Trích xuất middleware nếu có nhiều tham số
        const fullCall = match[0];
        const middlewares: string[] = [];
        if (fullCall.includes(',')) {
          const parts = fullCall.split(',').slice(1, -1).map((p) => p.trim());
          middlewares.push(...parts.filter((p) => p && !p.startsWith('(')));
        }

        routes.push({
          method: httpMethod,
          path: routePath,
          file: relPath,
          line,
          handler: handlerName,
          middlewares: middlewares.length > 0 ? middlewares : undefined,
          framework: 'Express/Hono/Fastify',
        });
      }

      // 2c. Decorator-based Routers (NestJS / Spring / Controller Decorators)
      const nestControllerRegex = /@Controller\s*\(\s*(['"`])?([^'"`\)]*)\1?\s*\)/g;
      const nestMethodRegex = /@(Get|Post|Put|Delete|Patch)\s*\(\s*(['"`])?([^'"`\)]*)\2?\s*\)[\s\S]*?(?:async\s+)?([a-zA-Z0-9_$]+)\s*\(/g;

      let controllerMatch: RegExpExecArray | null;
      let prefix = '';
      if ((controllerMatch = nestControllerRegex.exec(content)) !== null) {
        prefix = controllerMatch[2] ? '/' + controllerMatch[2].replace(/^\//, '') : '';
        let methodMatch: RegExpExecArray | null;
        while ((methodMatch = nestMethodRegex.exec(content)) !== null) {
          const httpMethod = methodMatch[1].toUpperCase() as RouteEntry['method'];
          const subPath = methodMatch[3] ? '/' + methodMatch[3].replace(/^\//, '') : '';
          const handlerName = methodMatch[4];
          const line = content.slice(0, methodMatch.index).split('\n').length;

          routes.push({
            method: httpMethod,
            path: (prefix + subPath).replace(/\/+/g, '/') || '/',
            file: relPath,
            line,
            handler: handlerName,
            framework: 'NestJS',
          });
        }
      }
    }

    // Lọc theo regex pathPattern nếu có
    let filtered = routes;
    if (pathPattern) {
      const regex = new RegExp(pathPattern, 'i');
      filtered = filtered.filter((r) => regex.test(r.path));
    }

    if (frameworkFilter && frameworkFilter !== 'auto') {
      const regex = new RegExp(frameworkFilter, 'i');
      filtered = filtered.filter((r) => r.framework && regex.test(r.framework));
    }

    return filtered;
  }

  /**
   * 3. View 360 độ toàn diện về một Symbol
   */
  getSymbolContext360(symbolName: string, filePath?: string): SymbolContext360Result {
    const cleanSymbol = symbolName.trim();
    const memberSymbol = cleanSymbol.split('.').filter(Boolean).pop() || cleanSymbol;
    let defFile = filePath;
    let defLine = 1;
    let defCharacter = 1;
    let kind = 'unknown';
    let typeSignature = '';
    let docComment = '';
    let isExported = false;

    // Tìm definition
    if (defFile) {
      const inspect = this.tsService.inspectSymbol(defFile, cleanSymbol);
      if (inspect.found) {
        defFile = inspect.file || defFile;
        kind = inspect.kind || 'symbol';
        defLine = inspect.line || 1;
        defCharacter = inspect.character || 1;
        typeSignature = inspect.typeSignature || '';
        docComment = inspect.docComment || '';
        isExported = Boolean(inspect.isExported);
      }
    } else {
      const inspect = this.findSymbolDefinitionAcrossWorkspace(cleanSymbol);
      if (inspect?.file) {
        defFile = inspect.file;
        defLine = inspect.line || 1;
        defCharacter = inspect.character || 1;
        kind = inspect.kind || 'symbol';
        typeSignature = inspect.typeSignature || '';
        docComment = inspect.docComment || '';
        isExported = Boolean(inspect.isExported);
      }
    }

    // Callers & Callees
    const callGraph = this.queryCallGraph(memberSymbol, defFile, 'both', 1);
    const callers = callGraph.callers.map((c) => ({ name: c.name, file: c.file, line: c.line }));
    const callees = callGraph.callees.map((c) => ({ name: c.name, file: c.file, line: c.line }));

    // Imported dependencies trong file định nghĩa
    const importedDependencies: string[] = [];
    if (defFile) {
      const safePath = this.workspace.resolveSafePath(defFile);
      if (fs.existsSync(safePath)) {
        const fileContent = fs.readFileSync(safePath, 'utf8');
        const importRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+[^,]+|[a-zA-Z0-9_$]+)\s+from\s+)?['"`]([^'"`]+)['"`]/g;
        let match: RegExpExecArray | null;
        while ((match = importRegex.exec(fileContent)) !== null) {
          importedDependencies.push(match[1]);
        }
      }
    }

    // Referencing files
    const refs = defFile
      ? this.tsService.findReferencesAt(defFile, defLine, defCharacter, 50)
      : [];
    const referencingFiles = Array.from(new Set(refs.map((r) => r.file)));

    // Related Tests
    const relatedTests: Array<{ file: string; line: number; preview: string }> = [];
    for (const ref of refs) {
      if (
        ref.file.includes('.test.') ||
        ref.file.includes('.spec.') ||
        ref.file.includes('test-suite') ||
        ref.file.includes('/tests/') ||
        ref.file.includes('__tests__')
      ) {
        relatedTests.push({
          file: ref.file,
          line: ref.line,
          preview: ref.preview,
        });
      }
    }

    return {
      symbol: cleanSymbol,
      kind,
      file: defFile
        ? (path.isAbsolute(defFile) ? this.workspace.toRelativePath(defFile) : defFile.replace(/\\/g, '/'))
        : undefined,
      line: defLine,
      typeSignature: typeSignature || undefined,
      docComment: docComment || undefined,
      isExported,
      callers,
      callees,
      importedDependencies,
      referencingFiles,
      relatedTests,
    };
  }

  /**
   * 4. Phân tích Topo Kiến trúc, Đồ thị Phụ thuộc & Phát hiện Vòng lặp (Circular Dependencies)
   * Tích hợp TypeScript Module Resolution (AST), Fast O(1) Lookup, In-Memory Caching & Martin Architecture Metrics
   */
  getArchitectureTopology(
    entryDir = 'src',
    options?: ArchitectureTopologyOptions,
  ): ArchitectureTopologyResult {
    const now = Date.now();
    if (
      !options?.forceRefresh &&
      this.cachedTopology &&
      this.cachedTopology.entryDir === entryDir &&
      now - this.cachedTopology.timestamp < 30_000
    ) {
      return this.cachedTopology.result;
    }

    const rootDir = this.workspace.resolveSafePath(entryDir);
    const scannedFiles = this.getAllCodeFiles(rootDir);
    const relFiles = scannedFiles.map((f) => this.workspace.toRelativePath(f).replace(/\\/g, '/'));

    const dependencyGraph: Record<string, string[]> = {};
    let totalDependencies = 0;

    // Fast O(1) Lookup Maps
    const fileSet = new Set(relFiles);
    const fileLookup = new Map<string, string>();
    for (const rel of relFiles) {
      const lower = rel.toLowerCase();
      fileLookup.set(lower, rel);
      const noExt = lower.replace(/\.[^.]+$/, '');
      if (!fileLookup.has(noExt)) {
        fileLookup.set(noExt, rel);
      }
    }

    const compilerOptions = this.tsService.getCompilerOptions ? this.tsService.getCompilerOptions() : {};
    const moduleResolutionHost: ts.ModuleResolutionHost = {
      fileExists: (fileName: string) => fs.existsSync(fileName),
      readFile: (fileName: string) => this.safeReadFile(fileName),
      directoryExists: (dir: string) => {
        try {
          return fs.statSync(dir).isDirectory();
        } catch {
          return false;
        }
      },
      getCurrentDirectory: () => this.workspace.rootDir,
      getDirectories: (dir: string) => {
        try {
          return fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
        } catch {
          return [];
        }
      },
    };

    // 4a. Xây dựng Dependency Graph
    for (const file of scannedFiles) {
      const relPath = this.workspace.toRelativePath(file).replace(/\\/g, '/');
      const content = this.safeReadFile(file);
      if (!content) continue;

      const specifiers = new Set<string>();
      const isTsOrJs = /\.[cm]?[jt]sx?$/i.test(file);

      // A. TypeScript/JavaScript AST parsing (Trích xuất sạch, loại trừ comment và template strings)
      if (isTsOrJs) {
        try {
          const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
          const visit = (node: ts.Node) => {
            if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
              specifiers.add(node.moduleSpecifier.text);
            } else if (
              ts.isExportDeclaration(node) &&
              node.moduleSpecifier &&
              ts.isStringLiteral(node.moduleSpecifier)
            ) {
              specifiers.add(node.moduleSpecifier.text);
            } else if (
              ts.isCallExpression(node) &&
              (node.expression.getText(sf) === 'require' || node.expression.kind === ts.SyntaxKind.ImportKeyword) &&
              node.arguments.length > 0 &&
              ts.isStringLiteral(node.arguments[0])
            ) {
              specifiers.add((node.arguments[0] as ts.StringLiteral).text);
            }
            ts.forEachChild(node, visit);
          };
          visit(sf);
        } catch {}
      }

      // B. Fallback Regex cho các ngôn ngữ khác hoặc khi AST gặp ngoại lệ
      if (specifiers.size === 0) {
        const importRegex = /(?:import|export\s+(?:\{|\*))\s+(?:[^'"`]*?\s+from\s+)?['"`]([^'"`]+)['"`]/g;
        let match: RegExpExecArray | null;
        while ((match = importRegex.exec(content)) !== null) {
          specifiers.add(match[1]);
        }

        const requireRegex = /require\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
        while ((match = requireRegex.exec(content)) !== null) {
          specifiers.add(match[1]);
        }

        if (/\.py$/i.test(file)) {
          const pyFromRegex = /from\s+([.\w]+)\s+import/g;
          while ((match = pyFromRegex.exec(content)) !== null) {
            specifiers.add(match[1].replace(/\./g, '/'));
          }
          const pyImportRegex = /import\s+([.\w]+)/g;
          while ((match = pyImportRegex.exec(content)) !== null) {
            specifiers.add(match[1].replace(/\./g, '/'));
          }
        }
      }

      const deps: string[] = [];
      for (const specifier of specifiers) {
        let matchedRel: string | undefined;

        // 1. Phân giải qua TypeScript Compiler API (hỗ trợ tsconfig paths, baseUrl, extensions, index.ts)
        if (isTsOrJs) {
          try {
            const resolved = ts.resolveModuleName(specifier, file, compilerOptions, moduleResolutionHost);
            if (resolved.resolvedModule && !resolved.resolvedModule.isExternalLibraryImport) {
              const absPath = resolved.resolvedModule.resolvedFileName;
              const relCandidate = this.workspace.toRelativePath(absPath).replace(/\\/g, '/');
              if (fileSet.has(relCandidate)) {
                matchedRel = relCandidate;
              }
            }
          } catch {}
        }

        // 2. Fallback relative path lookup qua Fast O(1) Hash Map
        if (!matchedRel && (specifier.startsWith('.') || specifier.startsWith('/'))) {
          const resolvedPath = path.resolve(path.dirname(file), specifier);
          const resolvedRel = this.workspace.toRelativePath(resolvedPath).replace(/\\/g, '/').toLowerCase();

          matchedRel =
            fileLookup.get(resolvedRel) ||
            fileLookup.get(`${resolvedRel}.ts`) ||
            fileLookup.get(`${resolvedRel}.tsx`) ||
            fileLookup.get(`${resolvedRel}.js`) ||
            fileLookup.get(`${resolvedRel}.jsx`) ||
            fileLookup.get(`${resolvedRel}/index.ts`) ||
            fileLookup.get(`${resolvedRel}/index.js`);
        }

        if (matchedRel && matchedRel !== relPath) {
          deps.push(matchedRel);
        }
      }

      dependencyGraph[relPath] = Array.from(new Set(deps));
      totalDependencies += dependencyGraph[relPath].length;
    }

    // 4b. Phân tầng kiến trúc (Architectural Layer Categorization)
    const layers: Record<string, ArchitectureLayer> = {
      controller: { name: 'Controller / API Layer', description: 'HTTP endpoints, routers, routes, CLI entrypoints', files: [] },
      service: { name: 'Service / Domain Layer', description: 'Core business logic, agents, workflows, engines', files: [] },
      repository: { name: 'Data / Repository Layer', description: 'Database access, models, entities, schemas', files: [] },
      ui: { name: 'UI / Presentation Layer', description: 'Components, views, pages, layouts, screens, hooks', files: [] },
      tools: { name: 'Tools / Integration Layer', description: 'Agent tool implementations, external APIs, MCP', files: [] },
      config: { name: 'Configuration Layer', description: 'Configuration, environment, constants', files: [] },
      utils: { name: 'Utility / Helper Layer', description: 'Shared utility functions, formats, types', files: [] },
      test: { name: 'Test Layer', description: 'Test suites, mocks, assertions', files: [] },
      other: { name: 'Other Modules', description: 'Bootstrap and general modules', files: [] },
    };

    for (const file of relFiles) {
      const layerKey = this.detectFileLayer(file);
      layers[layerKey].files.push(file);
    }

    // 4c. Thuật toán phát hiện Vòng lặp Phụ thuộc (Circular Dependency Cycle Detection)
    const circularCycles = this.findCircularCycles(dependencyGraph);

    // 4d. Phát hiện vi phạm phân tầng (Layer Violations)
    const layerViolations: LayerViolation[] = [];
    for (const [fromFile, toFiles] of Object.entries(dependencyGraph)) {
      const fromLayer = this.detectFileLayer(fromFile);
      for (const toFile of toFiles) {
        const toLayer = this.detectFileLayer(toFile);

        // Rule 1: Repository/Model không được phụ thuộc Controller, Tools, hoặc UI
        if (fromLayer === 'repository' && (toLayer === 'controller' || toLayer === 'tools' || toLayer === 'ui')) {
          layerViolations.push({
            from: fromFile,
            to: toFile,
            fromLayer,
            toLayer,
            rule: 'Repository layer should not depend on Controller, Tool, or UI layer.',
          });
        }
        // Rule 2: Util layer không được phụ thuộc Service, Controller, hoặc UI layer
        if (fromLayer === 'utils' && (toLayer === 'controller' || toLayer === 'service' || toLayer === 'ui')) {
          layerViolations.push({
            from: fromFile,
            to: toFile,
            fromLayer,
            toLayer,
            rule: 'Utility layer should not depend on Service, Controller, or UI layer.',
          });
        }
        // Rule 3: Config layer không được phụ thuộc Service hoặc Controller
        if (fromLayer === 'config' && (toLayer === 'service' || toLayer === 'controller')) {
          layerViolations.push({
            from: fromFile,
            to: toFile,
            fromLayer,
            toLayer,
            rule: 'Configuration layer should not depend on Service or Controller layer.',
          });
        }
        // Rule 4: UI layer không nên truy cập trực tiếp Repository layer
        if (fromLayer === 'ui' && toLayer === 'repository') {
          layerViolations.push({
            from: fromFile,
            to: toFile,
            fromLayer,
            toLayer,
            rule: 'UI layer should access Data via Service/Domain layer, not directly from Repository.',
          });
        }
      }
    }

    // 4e. Tính toán Chỉ số Kiến trúc (Architectural Metrics: Ca, Ce, Instability)
    const inDegrees: Record<string, number> = {};
    for (const file of relFiles) {
      inDegrees[file] = 0;
    }
    for (const targets of Object.values(dependencyGraph)) {
      for (const t of targets) {
        inDegrees[t] = (inDegrees[t] || 0) + 1;
      }
    }

    const allMetrics: NodeCouplingMetric[] = [];
    let totalInstability = 0;

    for (const file of relFiles) {
      const efferentCoupling = (dependencyGraph[file] || []).length;
      const afferentCoupling = inDegrees[file] || 0;
      const sum = afferentCoupling + efferentCoupling;
      const instability = sum === 0 ? 0 : Number((efferentCoupling / sum).toFixed(2));
      totalInstability += instability;

      allMetrics.push({
        file,
        afferentCoupling,
        efferentCoupling,
        instability,
      });
    }

    const avgInstability = relFiles.length === 0 ? 0 : Number((totalInstability / relFiles.length).toFixed(2));

    const hubNodes = [...allMetrics]
      .filter((m) => m.afferentCoupling > 0)
      .sort((a, b) => b.afferentCoupling - a.afferentCoupling)
      .slice(0, 5);

    const mostStableModules = [...allMetrics]
      .filter((m) => m.afferentCoupling > 0)
      .sort((a, b) => a.instability - b.instability || b.afferentCoupling - a.afferentCoupling)
      .slice(0, 5);

    const mostUnstableModules = [...allMetrics]
      .filter((m) => m.efferentCoupling > 0)
      .sort((a, b) => b.instability - a.instability || b.efferentCoupling - a.efferentCoupling)
      .slice(0, 5);

    const metrics: ArchitectureMetricsSummary = {
      averageInstability: avgInstability,
      hubNodes,
      mostStableModules,
      mostUnstableModules,
    };

    const result: ArchitectureTopologyResult = {
      totalFiles: relFiles.length,
      totalDependencies,
      layers,
      dependencyGraph,
      circularCycles,
      layerViolations,
      metrics,
    };

    // Cache kết quả trong RAM 30 giây
    this.cachedTopology = {
      entryDir,
      timestamp: now,
      result,
    };

    return result;
  }

  // --- Helper Methods ---

  private findSymbolDefinitionAcrossWorkspace(symbolName: string): any {
    if (!symbolName || isUtilityNoiseSymbol(symbolName)) return undefined;
    const files = this.getAllCodeFiles();
    for (const f of files) {
      const content = this.safeReadFile(f);
      if (!content || !content.includes(symbolName)) continue;
      const res = this.tsService.inspectSymbol(f, symbolName);
      if (res.found) return res;
    }
    return undefined;
  }

  private extractCallees(
    symbolName: string,
    filePath: string,
    depth: number,
    pruneNoise = true,
    visited = new Set<string>(),
  ): { nodes: CallNode[]; prunedCount: number } {
    const safePath = this.workspace.resolveSafePath(filePath);
    if (!fs.existsSync(safePath)) return { nodes: [], prunedCount: 0 };

    const fileContent = fs.readFileSync(safePath, 'utf8');
    const sourceFile = ts.createSourceFile(safePath, fileContent, ts.ScriptTarget.Latest, true);

    let symbolBodyNode: ts.Node | undefined;

    function findSymbolNode(node: ts.Node) {
      if (symbolBodyNode) return;
      if (
        (ts.isFunctionDeclaration(node) && node.name?.text === symbolName) ||
        (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === symbolName) ||
        (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === symbolName) ||
        (ts.isClassDeclaration(node) && node.name?.text === symbolName) ||
        (ts.isInterfaceDeclaration(node) && node.name?.text === symbolName)
      ) {
        symbolBodyNode = node;
        return;
      }
      ts.forEachChild(node, findSymbolNode);
    }
    findSymbolNode(sourceFile);

    let rawCalls: Array<{ name: string; file: string; line: number }> = [];

    if (!symbolBodyNode) {
      // Fallback cho C# / Unity / non-TS files
      const lines = fileContent.split('\n');
      const calls = new Map<string, { name: string; file: string; line: number }>();
      const declPattern = new RegExp(`(?:class|interface|struct|def|void|int|string|float|bool|async|public|private|protected)\\s+${symbolName}\\b`, 'i');
      let inScope = false;
      let braceCount = 0;
      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i];
        if (!inScope && declPattern.test(lineText)) {
          inScope = true;
          braceCount = (lineText.match(/\{/g) || []).length - (lineText.match(/\}/g) || []).length;
          continue;
        }
        if (inScope) {
          braceCount += (lineText.match(/\{/g) || []).length - (lineText.match(/\}/g) || []).length;
          const callMatches = lineText.matchAll(/\b([A-Za-z0-9_]+)\s*\(/g);
          for (const m of callMatches) {
            const calledName = m[1];
            const keywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'sizeof', 'typeof', 'using', 'return', 'new']);
            if (calledName && calledName !== symbolName && !keywords.has(calledName) && !calls.has(calledName)) {
              calls.set(calledName, {
                name: calledName,
                file: this.workspace.toRelativePath(filePath),
                line: i + 1,
              });
            }
          }
          if (braceCount <= 0 && lineText.includes('}')) {
            break;
          }
        }
      }
      rawCalls = Array.from(calls.values());
    } else {
      const calls = new Map<string, { name: string; file: string; line: number }>();
      const visitCalls = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
          let calledName = '';
          if (ts.isIdentifier(node.expression)) {
            calledName = node.expression.text;
          } else if (ts.isPropertyAccessExpression(node.expression)) {
            calledName = node.expression.name.text;
          }

          if (calledName && calledName !== symbolName && !calls.has(calledName)) {
            const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            calls.set(calledName, {
              name: calledName,
              file: this.workspace.toRelativePath(filePath),
              line: line + 1,
            });
          }
        }
        ts.forEachChild(node, visitCalls);
      };
      visitCalls(symbolBodyNode);
      rawCalls = Array.from(calls.values());
    }

    let prunedCount = 0;
    const nodes: CallNode[] = [];
    let subDepthCount = 0;

    for (const raw of rawCalls) {
      const isNoise = isUtilityNoiseSymbol(raw.name);
      if (isNoise) {
        prunedCount++;
        if (pruneNoise) continue;
      }
      const callNode: CallNode = {
        name: raw.name,
        file: raw.file,
        line: raw.line,
        depth: 1,
        relevance: isNoise ? 'utility' : 'high',
        isPruned: isNoise && pruneNoise,
      };

      // 2-hop Bounded Subgraph traversal nếu depth >= 2 (giới hạn max 5 sub-nodes để tránh bùng nổ AST scan)
      if (depth >= 2 && !isNoise && !visited.has(raw.name) && subDepthCount < 5) {
        visited.add(raw.name);
        subDepthCount++;
        const def = this.findSymbolDefinitionAcrossWorkspace(raw.name);
        if (def?.file) {
          const sub = this.extractCallees(raw.name, def.file, depth - 1, pruneNoise, visited);
          if (sub.nodes.length > 0) {
            callNode.children = sub.nodes.map((c) => ({ ...c, depth: 2 }));
            prunedCount += sub.prunedCount;
          }
        }
      }
      nodes.push(callNode);
    }

    return { nodes, prunedCount };
  }

  private extractCallers(
    symbolName: string,
    depth: number,
    pruneNoise = true,
    visited = new Set<string>(),
  ): { nodes: CallNode[]; prunedCount: number } {
    const callers: CallNode[] = [];
    const scannedFiles = this.getAllCodeFiles();
    let prunedCount = 0;

    for (const file of scannedFiles) {
      const content = this.safeReadFile(file);
      if (!content || !content.includes(symbolName)) continue;

      const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
      let currentEnclosingFunction: string | undefined;

      const visit = (node: ts.Node) => {
        const prevFunction = currentEnclosingFunction;

        if (ts.isFunctionDeclaration(node) && node.name) {
          currentEnclosingFunction = node.name.text;
        } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
          currentEnclosingFunction = node.name.text;
        } else if (ts.isClassDeclaration(node) && node.name) {
          currentEnclosingFunction = `Class:${node.name.text}`;
        }

        if (ts.isCallExpression(node)) {
          let called = '';
          if (ts.isIdentifier(node.expression)) {
            called = node.expression.text;
          } else if (ts.isPropertyAccessExpression(node.expression)) {
            called = node.expression.name.text;
          }

          if (called === symbolName) {
            const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            const callerName = currentEnclosingFunction || 'TopLevelScript';
            const isNoise = isUtilityNoiseSymbol(callerName);
            if (isNoise) {
              prunedCount++;
            }
            if (!isNoise || !pruneNoise) {
              if (!callers.some((c) => c.name === callerName && c.file === this.workspace.toRelativePath(file) && c.line === line + 1)) {
                callers.push({
                  name: callerName,
                  file: this.workspace.toRelativePath(file),
                  line: line + 1,
                  depth: 1,
                  relevance: isNoise ? 'utility' : 'high',
                });
              }
            }
          }
        }

        ts.forEachChild(node, visit);
        currentEnclosingFunction = prevFunction;
      };

      visit(sourceFile);

      // Fallback cho C# / Unity / non-TS files nếu AST không bắt được call expression
      if (callers.length === 0 && (file.endsWith('.cs') || file.endsWith('.py') || file.endsWith('.shader'))) {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          if (l.includes(symbolName) && !l.includes(`class ${symbolName}`) && !l.includes(`interface ${symbolName}`)) {
            const callerName = path.basename(file, path.extname(file));
            const relFile = this.workspace.toRelativePath(file);
            const isNoise = isUtilityNoiseSymbol(callerName);
            if (isNoise) prunedCount++;
            if (!isNoise || !pruneNoise) {
              if (!callers.some((c) => c.name === callerName && c.file === relFile && c.line === i + 1)) {
                callers.push({
                  name: callerName,
                  file: relFile,
                  line: i + 1,
                  depth: 1,
                  relevance: isNoise ? 'utility' : 'high',
                });
              }
            }
          }
        }
      }
    }

    // 2-hop Bounded Subgraph cho Callers nếu depth >= 2 (giới hạn max 3 callers có ý nghĩa, tránh scan bão hòa)
    if (depth >= 2) {
      const candidates = callers
        .filter(
          (c) =>
            c.relevance === 'high' &&
            !visited.has(c.name) &&
            c.name !== 'TopLevelScript' &&
            !c.name.startsWith('test') &&
            !c.name.startsWith('describe') &&
            !c.name.startsWith('it')
        )
        .slice(0, 3);

      for (const caller of candidates) {
        visited.add(caller.name);
        const sub = this.extractCallers(caller.name, depth - 1, pruneNoise, visited);
        if (sub.nodes.length > 0) {
          caller.children = sub.nodes.map((c) => ({ ...c, depth: 2 }));
          prunedCount += sub.prunedCount;
        }
      }
    }

    return { nodes: callers, prunedCount };
  }

  private findCircularCycles(graph: Record<string, string[]>): CircularDependencyCycle[] {
    const cycles: CircularDependencyCycle[] = [];
    const seenCycleSignatures = new Set<string>();

    const canonicalizeCycle = (nodes: string[]): string[] => {
      if (nodes.length <= 1) return nodes;
      const pathNodes = nodes[0] === nodes[nodes.length - 1] ? nodes.slice(0, -1) : [...nodes];
      let minIdx = 0;
      for (let i = 1; i < pathNodes.length; i++) {
        if (pathNodes[i] < pathNodes[minIdx]) {
          minIdx = i;
        }
      }
      const rotated = [...pathNodes.slice(minIdx), ...pathNodes.slice(0, minIdx)];
      rotated.push(rotated[0]);
      return rotated;
    };

    const visited = new Set<string>();
    const recStack: string[] = [];
    const recSet = new Set<string>();

    const dfs = (curr: string) => {
      visited.add(curr);
      recStack.push(curr);
      recSet.add(curr);

      const neighbors = graph[curr] || [];
      for (const next of neighbors) {
        if (!visited.has(next)) {
          dfs(next);
        } else if (recSet.has(next)) {
          const startIndex = recStack.indexOf(next);
          if (startIndex !== -1) {
            const rawCycle = recStack.slice(startIndex).concat(next);
            const canonical = canonicalizeCycle(rawCycle);
            const sig = canonical.join(' -> ');
            if (!seenCycleSignatures.has(sig)) {
              seenCycleSignatures.add(sig);
              cycles.push({
                cycle: canonical,
                length: canonical.length - 1,
              });
            }
          }
        }
      }

      recStack.pop();
      recSet.delete(curr);
    };

    for (const node of Object.keys(graph)) {
      if (!visited.has(node)) {
        dfs(node);
      }
    }

    cycles.sort((a, b) => a.length - b.length);
    return cycles;
  }

  detectFileLayer(file: string): ArchitectureLayerKey {
    const lower = file.toLowerCase().replace(/\\/g, '/');
    if (
      lower.includes('.test.') ||
      lower.includes('.spec.') ||
      lower.includes('__tests__') ||
      lower.includes('/mock') ||
      lower.includes('test-suite')
    ) {
      return 'test';
    }
    if (
      lower.includes('route') ||
      lower.includes('controller') ||
      lower.includes('endpoint') ||
      lower.includes('api/') ||
      lower.includes('cli.') ||
      lower.endsWith('/cli.ts') ||
      lower.endsWith('/index.ts')
    ) {
      return 'controller';
    }
    if (
      lower.includes('model') ||
      lower.includes('schema') ||
      lower.includes('entity') ||
      lower.includes('repo') ||
      lower.includes('db/') ||
      lower.includes('database') ||
      lower.includes('migration') ||
      lower.includes('store')
    ) {
      return 'repository';
    }
    if (
      lower.includes('component') ||
      lower.includes('/view') ||
      lower.includes('/page') ||
      lower.includes('/ui/') ||
      lower.includes('/hooks/') ||
      lower.includes('layout') ||
      lower.includes('screen') ||
      lower.includes('widget')
    ) {
      return 'ui';
    }
    if (
      lower.includes('tool') ||
      lower.includes('plugin') ||
      lower.includes('integration') ||
      lower.includes('/mcp')
    ) {
      return 'tools';
    }
    if (
      lower.includes('config') ||
      lower.includes('constant') ||
      lower.includes('env') ||
      lower.includes('.config.')
    ) {
      return 'config';
    }
    if (
      lower.includes('agent') ||
      lower.includes('service') ||
      lower.includes('kernel') ||
      lower.includes('core') ||
      lower.includes('engine') ||
      lower.includes('workflow') ||
      lower.includes('orchestrat')
    ) {
      return 'service';
    }
    if (
      lower.includes('util') ||
      lower.includes('helper') ||
      lower.includes('types') ||
      lower.includes('sanitizer') ||
      lower.includes('format')
    ) {
      return 'utils';
    }
    return 'other';
  }

  private getAllCodeFiles(dir = this.workspace.rootDir): string[] {
    const results: string[] = [];
    try {
      const scan = (current: string) => {
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
          if (this.workspace.isIgnoredDirectory(entry.name)) continue;
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) {
            scan(full);
          } else if (entry.isFile()) {
            if (/\.(ts|tsx|js|jsx|py|go|rs|java|cpp|c|cs|shader|hlsl)$/i.test(entry.name)) {
              results.push(full);
            }
          }
        }
      };
      scan(dir);
    } catch {}
    return results;
  }

  private safeReadFile(filePath: string): string | undefined {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return undefined;
    }
  }
}
