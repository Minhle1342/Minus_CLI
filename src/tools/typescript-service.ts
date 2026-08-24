import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../workspace/workspace.js';

export interface SymbolDefinitionResult {
  found: boolean;
  name: string;
  kind?: string;
  line?: number;
  character?: number;
  file?: string;
  typeSignature?: string;
  isExported?: boolean;
  docComment?: string;
}

export interface SymbolReferenceResult {
  file: string;
  line: number;
  character: number;
  preview: string;
  isDefinition: boolean;
}

export interface DiagnosticItem {
  file: string;
  line: number;
  character: number;
  message: string;
  code: number;
  category: 'error' | 'warning' | 'suggestion' | 'message';
}

/**
 * TypeScriptService
 * 
 * Host quản lý TypeScript Language Service dài hạn (long-lived) phục vụ:
 * 1. Syntax & Semantic Diagnostics theo thời gian thực (không cần chạy lại tsc CLI từ đầu).
 * 2. Định vị định nghĩa Symbol, type signature, export status.
 * 3. Tìm kiếm toàn bộ References ngữ nghĩa (semantic references) thay vì grep mù.
 */
export class TypeScriptService {
  private workspace: Workspace;
  private services: ts.LanguageService;
  private files: Map<string, { version: number; content: string }> = new Map();
  private rootFileNames: Set<string> = new Set();
  private compilerOptions: ts.CompilerOptions;

  constructor(workspace: Workspace) {
    this.workspace = workspace;
    this.compilerOptions = this.loadCompilerOptions();

    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => Array.from(this.rootFileNames),
      getScriptVersion: (fileName) => this.files.get(path.normalize(fileName))?.version.toString() || '0',
      getScriptSnapshot: (fileName) => {
        const normalized = path.normalize(fileName);
        let file = this.files.get(normalized);
        if (!file && fs.existsSync(normalized)) {
          try {
            const content = fs.readFileSync(normalized, 'utf8');
            file = { version: 1, content };
            this.files.set(normalized, file);
            this.rootFileNames.add(normalized);
          } catch {
            return undefined;
          }
        }
        if (!file) return undefined;
        return ts.ScriptSnapshot.fromString(file.content);
      },
      getCurrentDirectory: () => this.workspace.rootDir,
      getCompilationSettings: () => this.compilerOptions,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: (fileName) => fs.existsSync(fileName),
      readFile: (fileName) => {
        try {
          return fs.readFileSync(fileName, 'utf8');
        } catch {
          return undefined;
        }
      },
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
    };

    this.services = ts.createLanguageService(host, ts.createDocumentRegistry());
    this.syncWorkspaceFiles();
  }

  private loadCompilerOptions(): ts.CompilerOptions {
    const configPath = path.join(this.workspace.rootDir, 'tsconfig.json');
    if (fs.existsSync(configPath)) {
      try {
        const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
        if (configFile.config) {
          const parsed = ts.parseJsonConfigFileContent(
            configFile.config,
            ts.sys,
            this.workspace.rootDir,
          );
          return parsed.options;
        }
      } catch {}
    }

    return {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      allowJs: true,
    };
  }

  syncWorkspaceFiles(): void {
    try {
      const scanDir = (dir: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (this.workspace.isIgnoredDirectory(entry.name)) continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js') || entry.name.endsWith('.tsx') || entry.name.endsWith('.jsx'))) {
            const normalized = path.normalize(fullPath);
            this.rootFileNames.add(normalized);
          }
        }
      };
      scanDir(this.workspace.rootDir);
    } catch {}
  }

  updateFile(filePath: string, content?: string): void {
    const safePath = this.workspace.resolveSafePath(filePath);
    const normalized = path.normalize(safePath);
    const fileContent = content !== undefined ? content : fs.readFileSync(normalized, 'utf8');
    const existing = this.files.get(normalized);

    if (existing) {
      existing.version++;
      existing.content = fileContent;
    } else {
      this.files.set(normalized, { version: 1, content: fileContent });
      this.rootFileNames.add(normalized);
    }
  }

  getDiagnostics(filePath?: string): DiagnosticItem[] {
    const results: DiagnosticItem[] = [];
    const targetFiles = filePath
      ? [path.normalize(this.workspace.resolveSafePath(filePath))]
      : Array.from(this.rootFileNames);

    for (const file of targetFiles) {
      if (!fs.existsSync(file)) continue;
      this.updateFile(file);

      const syntactic = this.services.getSyntacticDiagnostics(file);
      const semantic = this.services.getSemanticDiagnostics(file);
      const allDiag = [...syntactic, ...semantic];

      for (const diag of allDiag) {
        if (!diag.file || diag.start === undefined) continue;
        const { line, character } = diag.file.getLineAndCharacterOfPosition(diag.start);
        const categoryMap: Record<ts.DiagnosticCategory, DiagnosticItem['category']> = {
          [ts.DiagnosticCategory.Error]: 'error',
          [ts.DiagnosticCategory.Warning]: 'warning',
          [ts.DiagnosticCategory.Suggestion]: 'suggestion',
          [ts.DiagnosticCategory.Message]: 'message',
        };

        results.push({
          file: this.workspace.toRelativePath(diag.file.fileName),
          line: line + 1,
          character: character + 1,
          message: ts.flattenDiagnosticMessageText(diag.messageText, '\n'),
          code: diag.code,
          category: categoryMap[diag.category] || 'error',
        });
      }
    }

    return results;
  }

  inspectSymbol(filePath: string, symbolName: string): SymbolDefinitionResult {
    const safePath = this.workspace.resolveSafePath(filePath);
    const normalized = path.normalize(safePath);
    this.updateFile(normalized);

    const program = this.services.getProgram();
    if (!program) return { found: false, name: symbolName };

    const sourceFile = program.getSourceFile(normalized);
    if (!sourceFile) return { found: false, name: symbolName };

    const typeChecker = program.getTypeChecker();
    let foundResult: SymbolDefinitionResult = { found: false, name: symbolName };

    function visit(node: ts.Node) {
      if (foundResult.found) return;

      if (
        (ts.isFunctionDeclaration(node) && node.name?.text === symbolName) ||
        (ts.isClassDeclaration(node) && node.name?.text === symbolName) ||
        (ts.isInterfaceDeclaration(node) && node.name?.text === symbolName) ||
        (ts.isTypeAliasDeclaration(node) && node.name?.text === symbolName) ||
        (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === symbolName)
      ) {
        const { line, character } = sourceFile!.getLineAndCharacterOfPosition(node.getStart());
        const symbol = typeChecker.getSymbolAtLocation(node.name || node);
        let typeSignature = '';
        let docComment = '';
        let isExported = false;

        if (symbol) {
          const type = typeChecker.getTypeOfSymbolAtLocation(symbol, node);
          typeSignature = typeChecker.typeToString(type);
          docComment = ts.displayPartsToString(symbol.getDocumentationComment(typeChecker));
        }

        // Check exported
        const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
        if (modifiers) {
          isExported = modifiers.some((m: ts.Modifier) => m.kind === ts.SyntaxKind.ExportKeyword);
        }

        let kind = 'unknown';
        if (ts.isFunctionDeclaration(node)) kind = 'function';
        else if (ts.isClassDeclaration(node)) kind = 'class';
        else if (ts.isInterfaceDeclaration(node)) kind = 'interface';
        else if (ts.isTypeAliasDeclaration(node)) kind = 'type';
        else if (ts.isVariableDeclaration(node)) kind = 'variable';

        foundResult = {
          found: true,
          name: symbolName,
          kind,
          line: line + 1,
          character: character + 1,
          file: path.relative(process.cwd(), sourceFile!.fileName).replace(/\\/g, '/'),
          typeSignature,
          isExported,
          docComment: docComment || undefined,
        };
        return;
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return foundResult;
  }

  findReferences(filePath: string, symbolName: string, limit: number = 50): SymbolReferenceResult[] {
    const safePath = this.workspace.resolveSafePath(filePath);
    const normalized = path.normalize(safePath);
    this.updateFile(normalized);

    const program = this.services.getProgram();
    if (!program) return [];

    const sourceFile = program.getSourceFile(normalized);
    if (!sourceFile) return [];

    let targetPos: number | undefined;

    function findNodePos(node: ts.Node) {
      if (targetPos !== undefined) return;
      if (ts.isIdentifier(node) && node.text === symbolName) {
        targetPos = node.getStart();
        return;
      }
      ts.forEachChild(node, findNodePos);
    }
    findNodePos(sourceFile);

    if (targetPos === undefined) return [];

    const refEntries = this.services.findReferences(normalized, targetPos);
    if (!refEntries) return [];

    const results: SymbolReferenceResult[] = [];

    for (const entry of refEntries) {
      for (const ref of entry.references) {
        if (results.length >= limit) break;
        const refSource = program.getSourceFile(ref.fileName);
        if (!refSource) continue;

        const { line, character } = refSource.getLineAndCharacterOfPosition(ref.textSpan.start);
        const lineText = refSource.text.split('\n')[line]?.trim() || '';

        results.push({
          file: this.workspace.toRelativePath(ref.fileName),
          line: line + 1,
          character: character + 1,
          preview: lineText.slice(0, 160),
          isDefinition: Boolean(ref.isDefinition),
        });
      }
    }

    return results;
  }
}
