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
}

export interface CallGraphResult {
  symbol: string;
  file?: string;
  line?: number;
  direction: 'callers' | 'callees' | 'both';
  callees: CallNode[];
  callers: CallNode[];
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

export interface ArchitectureLayer {
  name: string;
  description: string;
  files: string[];
}

export interface CircularDependencyCycle {
  cycle: string[];
  length: number;
}

export interface ArchitectureTopologyResult {
  totalFiles: number;
  totalDependencies: number;
  layers: Record<string, ArchitectureLayer>;
  dependencyGraph: Record<string, string[]>;
  circularCycles: CircularDependencyCycle[];
  layerViolations: Array<{ from: string; to: string; fromLayer: string; toLayer: string; rule: string }>;
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

  constructor(workspace: Workspace, tsService?: TypeScriptService) {
    this.workspace = workspace;
    this.tsService = tsService || new TypeScriptService(workspace);
  }

  getTypeScriptService(): TypeScriptService {
    return this.tsService;
  }

  /**
   * 1. Xây dựng Call Graph 2 chiều (Callers & Callees) với độ sâu tùy chỉnh
   */
  queryCallGraph(
    symbolName: string,
    filePath?: string,
    direction: 'callers' | 'callees' | 'both' = 'both',
    maxDepth: number = 2,
  ): CallGraphResult {
    this.tsService.syncWorkspaceFiles();
    const cleanSymbol = symbolName.trim();
    const depth = Math.min(Math.max(1, maxDepth), 5);

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

    if (direction === 'callees' || direction === 'both') {
      if (targetFile) {
        const foundCallees = this.extractCallees(cleanSymbol, targetFile, depth);
        callees.push(...foundCallees);
      }
    }

    if (direction === 'callers' || direction === 'both') {
      const foundCallers = this.extractCallers(cleanSymbol, depth);
      callers.push(...foundCallers);
    }

    return {
      symbol: cleanSymbol,
      file: targetFile ? this.workspace.toRelativePath(targetFile) : undefined,
      line: targetLine,
      direction,
      callees,
      callers,
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
    let defFile = filePath;
    let defLine = 1;
    let kind = 'unknown';
    let typeSignature = '';
    let docComment = '';
    let isExported = false;

    // Tìm definition
    if (defFile) {
      const inspect = this.tsService.inspectSymbol(defFile, cleanSymbol);
      if (inspect.found) {
        kind = inspect.kind || 'symbol';
        defLine = inspect.line || 1;
        typeSignature = inspect.typeSignature || '';
        docComment = inspect.docComment || '';
        isExported = Boolean(inspect.isExported);
      }
    } else {
      const inspect = this.findSymbolDefinitionAcrossWorkspace(cleanSymbol);
      if (inspect?.file) {
        defFile = inspect.file;
        defLine = inspect.line || 1;
        kind = inspect.kind || 'symbol';
        typeSignature = inspect.typeSignature || '';
        docComment = inspect.docComment || '';
        isExported = Boolean(inspect.isExported);
      }
    }

    // Callers & Callees
    const callGraph = this.queryCallGraph(cleanSymbol, defFile, 'both', 1);
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
    const refs = defFile ? this.tsService.findReferences(defFile, cleanSymbol, 50) : [];
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
      file: defFile ? this.workspace.toRelativePath(defFile) : undefined,
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
   * 4. Phân tích Topo Kiến trúc & Phát hiện Vòng lặp Phụ thuộc (Circular Dependencies)
   */
  getArchitectureTopology(entryDir = 'src'): ArchitectureTopologyResult {
    const rootDir = this.workspace.resolveSafePath(entryDir);
    const scannedFiles = this.getAllCodeFiles(rootDir);
    const relFiles = scannedFiles.map((f) => this.workspace.toRelativePath(f).replace(/\\/g, '/'));

    const dependencyGraph: Record<string, string[]> = {};
    let totalDependencies = 0;

    // 4a. Xây dựng Dependency Graph
    for (const file of scannedFiles) {
      const relPath = this.workspace.toRelativePath(file).replace(/\\/g, '/');
      const content = this.safeReadFile(file);
      if (!content) continue;

      const deps: string[] = [];
      const importRegex = /(?:import|export\s+(?:\{|\*))\s+(?:[^'"`]*?\s+from\s+)?['"`]([^'"`]+)['"`]/g;
      let match: RegExpExecArray | null;

      while ((match = importRegex.exec(content)) !== null) {
        const importSpecifier = match[1];
        if (importSpecifier.startsWith('.')) {
          // Resolve relative path
          const resolvedPath = path.resolve(path.dirname(file), importSpecifier);
          const resolvedRel = this.workspace.toRelativePath(resolvedPath).replace(/\\/g, '/');
          
          // Thử tìm file tương ứng với các extension
          const matchedTarget = relFiles.find((f) => {
            const noExt = f.replace(/\.(ts|tsx|js|jsx)$/, '');
            const targetNoExt = resolvedRel.replace(/\.(ts|tsx|js|jsx)$/, '');
            return f === resolvedRel || noExt === targetNoExt || f === `${resolvedRel}/index.ts` || f === `${resolvedRel}/index.js`;
          });

          if (matchedTarget && matchedTarget !== relPath) {
            deps.push(matchedTarget);
          }
        }
      }

      dependencyGraph[relPath] = Array.from(new Set(deps));
      totalDependencies += dependencyGraph[relPath].length;
    }

    // 4b. Phân tầng kiến trúc (Architectural Layer Categorization)
    const layers: Record<string, ArchitectureLayer> = {
      controller: { name: 'Controller / API Layer', description: 'HTTP endpoints, routers, routes', files: [] },
      service: { name: 'Service / Domain Layer', description: 'Core business logic, agents, workflows, engines', files: [] },
      repository: { name: 'Data / Repository Layer', description: 'Database access, models, entities, schemas', files: [] },
      tools: { name: 'Tools / Integration Layer', description: 'Agent tool implementations, external APIs', files: [] },
      utils: { name: 'Utility / Helper Layer', description: 'Shared utility functions, formats, types', files: [] },
      test: { name: 'Test Layer', description: 'Test suites, mocks, assertions', files: [] },
      other: { name: 'Other Modules', description: 'Configuration, bootstrap, entry points', files: [] },
    };

    for (const file of relFiles) {
      const lower = file.toLowerCase();
      if (lower.includes('test') || lower.includes('spec') || lower.includes('mock')) {
        layers.test.files.push(file);
      } else if (lower.includes('route') || lower.includes('controller') || lower.includes('api/')) {
        layers.controller.files.push(file);
      } else if (lower.includes('model') || lower.includes('schema') || lower.includes('entity') || lower.includes('repo') || lower.includes('db/')) {
        layers.repository.files.push(file);
      } else if (lower.includes('tool') || lower.includes('plugin')) {
        layers.tools.files.push(file);
      } else if (lower.includes('util') || lower.includes('helper') || lower.includes('types')) {
        layers.utils.files.push(file);
      } else if (lower.includes('agent') || lower.includes('service') || lower.includes('kernel') || lower.includes('core')) {
        layers.service.files.push(file);
      } else {
        layers.other.files.push(file);
      }
    }

    // 4c. Thuật toán phát hiện Vòng lặp Phụ thuộc (Circular Dependency Cycle Detection via Tarjan / DFS)
    const circularCycles = this.findCircularCycles(dependencyGraph);

    // 4d. Phát hiện vi phạm phân tầng (Layer Violations)
    const layerViolations: ArchitectureTopologyResult['layerViolations'] = [];
    for (const [fromFile, toFiles] of Object.entries(dependencyGraph)) {
      const fromLayer = this.detectFileLayer(fromFile);
      for (const toFile of toFiles) {
        const toLayer = this.detectFileLayer(toFile);

        // Rule: Repository/Model không được phụ thuộc Controller/Route
        if (fromLayer === 'repository' && (toLayer === 'controller' || toLayer === 'tools')) {
          layerViolations.push({
            from: fromFile,
            to: toFile,
            fromLayer,
            toLayer,
            rule: 'Repository layer should not depend on Controller or Tool layer.',
          });
        }
        // Rule: Util layer không được phụ thuộc Service/Controller layer
        if (fromLayer === 'utils' && (toLayer === 'controller' || toLayer === 'service')) {
          layerViolations.push({
            from: fromFile,
            to: toFile,
            fromLayer,
            toLayer,
            rule: 'Utility layer should not depend on Service or Controller layer.',
          });
        }
      }
    }

    return {
      totalFiles: relFiles.length,
      totalDependencies,
      layers,
      dependencyGraph,
      circularCycles,
      layerViolations,
    };
  }

  // --- Helper Methods ---

  private findSymbolDefinitionAcrossWorkspace(symbolName: string): any {
    const files = this.getAllCodeFiles();
    for (const f of files) {
      const res = this.tsService.inspectSymbol(f, symbolName);
      if (res.found) return res;
    }
    return undefined;
  }

  private extractCallees(symbolName: string, filePath: string, depth: number): CallNode[] {
    const safePath = this.workspace.resolveSafePath(filePath);
    if (!fs.existsSync(safePath)) return [];

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

    if (!symbolBodyNode) {
      // Fallback cho C# / Unity / non-TS files
      const lines = fileContent.split('\n');
      const calls = new Map<string, CallNode>();
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
      return Array.from(calls.values());
    }

    const calls = new Map<string, CallNode>();

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
    return Array.from(calls.values());
  }

  private extractCallers(symbolName: string, depth: number): CallNode[] {
    const callers: CallNode[] = [];
    const scannedFiles = this.getAllCodeFiles();

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
            if (!callers.some((c) => c.name === callerName && c.file === this.workspace.toRelativePath(file) && c.line === line + 1)) {
              callers.push({
                name: callerName,
                file: this.workspace.toRelativePath(file),
                line: line + 1,
              });
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
            if (!callers.some((c) => c.name === callerName && c.file === relFile && c.line === i + 1)) {
              callers.push({
                name: callerName,
                file: relFile,
                line: i + 1,
              });
            }
          }
        }
      }
    }

    return callers;
  }

  private findCircularCycles(graph: Record<string, string[]>): CircularDependencyCycle[] {
    const visited = new Set<string>();
    const recursionStack: string[] = [];
    const cycles: CircularDependencyCycle[] = [];

    const dfs = (node: string) => {
      visited.add(node);
      recursionStack.push(node);

      const neighbors = graph[node] || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          dfs(neighbor);
        } else if (recursionStack.includes(neighbor)) {
          const cycleStartIndex = recursionStack.indexOf(neighbor);
          const cyclePath = recursionStack.slice(cycleStartIndex).concat(neighbor);
          cycles.push({
            cycle: cyclePath,
            length: cyclePath.length - 1,
          });
        }
      }

      recursionStack.pop();
    };

    for (const node of Object.keys(graph)) {
      if (!visited.has(node)) {
        dfs(node);
      }
    }

    return cycles;
  }

  private detectFileLayer(file: string): string {
    const lower = file.toLowerCase();
    if (lower.includes('test') || lower.includes('spec')) return 'test';
    if (lower.includes('route') || lower.includes('controller') || lower.includes('api/')) return 'controller';
    if (lower.includes('model') || lower.includes('schema') || lower.includes('entity') || lower.includes('repo')) return 'repository';
    if (lower.includes('tool') || lower.includes('plugin')) return 'tools';
    if (lower.includes('util') || lower.includes('helper') || lower.includes('types')) return 'utils';
    if (lower.includes('agent') || lower.includes('service') || lower.includes('kernel')) return 'service';
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
