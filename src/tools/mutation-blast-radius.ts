import ts from 'typescript';
import path from 'node:path';
import fs from 'node:fs';
import type { Workspace } from '../workspace/workspace.js';
import { CodebaseIntelligenceService } from './codebase-intelligence.js';
import { TypeScriptService } from './typescript-service.js';

export type ImpactRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface ChangedSymbolInfo {
  name: string;
  kind: 'function' | 'class' | 'method' | 'interface' | 'type' | 'variable' | 'enum' | 'unknown';
  isExported: boolean;
  line?: number;
  signatureChanged?: boolean;
  breakingChange?: boolean;
}

export interface EnrichedBlastRadius {
  risk: ImpactRiskLevel;
  score: number;
  targetFile: string;
  depth: number;
  modifiedSymbols: ChangedSymbolInfo[];
  directConsumers: string[];
  transitiveFiles: string[];
  impactedTestSuites: string[];
  callers: Array<{ name: string; file: string; line: number }>;
  publicApiAffected: boolean;
  breakingChange: boolean;
  warnings: string[];
  recommendedActions: string[];
}

interface CachedDependencyTopology {
  timestamp: number;
  workspaceRoot: string;
  forwardGraph: Record<string, string[]>;
  reverseGraph: Record<string, string[]>;
  allCodeFiles: string[];
}

let cachedTopology: CachedDependencyTopology | undefined;
let sharedIntelligenceService: CodebaseIntelligenceService | undefined;

function getIntelligenceService(workspace: Workspace): CodebaseIntelligenceService {
  if (!sharedIntelligenceService) {
    sharedIntelligenceService = new CodebaseIntelligenceService(workspace);
  }
  return sharedIntelligenceService;
}

/**
 * Invalidate cached topology when files are modified.
 */
export function invalidateTopologyCache(): void {
  cachedTopology = undefined;
}

/**
 * 1. AST-based changed symbols detector
 * So sánh AST cũ và mới để xác định chính xác danh sách hàm, class, interface bị sửa đổi
 */
export function detectChangedSymbols(
  filePath: string,
  oldContent: string | undefined,
  newContent: string,
): ChangedSymbolInfo[] {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    return detectChangedSymbolsNonTs(oldContent, newContent);
  }

  const results: ChangedSymbolInfo[] = [];

  try {
    const oldSourceFile = oldContent
      ? ts.createSourceFile(filePath, oldContent, ts.ScriptTarget.Latest, true)
      : undefined;
    const newSourceFile = ts.createSourceFile(filePath, newContent, ts.ScriptTarget.Latest, true);

    const oldDecls = oldSourceFile ? extractDeclarations(oldSourceFile) : new Map<string, DeclSummary>();
    const newDecls = extractDeclarations(newSourceFile);

    // Phát hiện các symbol bị sửa đổi hoặc mới thêm
    for (const [key, newDecl] of newDecls.entries()) {
      const oldDecl = oldDecls.get(key);
      if (!oldDecl) {
        // Symbol mới tạo
        results.push({
          name: newDecl.name,
          kind: newDecl.kind,
          isExported: newDecl.isExported,
          line: newDecl.line,
          signatureChanged: false,
          breakingChange: false,
        });
      } else {
        // Đã tồn tại -> kiểm tra xem nội dung hoặc chữ ký có thay đổi không
        const bodyChanged = oldDecl.text !== newDecl.text;
        const sigChanged = oldDecl.signatureText !== newDecl.signatureText;
        if (bodyChanged || sigChanged) {
          results.push({
            name: newDecl.name,
            kind: newDecl.kind,
            isExported: newDecl.isExported,
            line: newDecl.line,
            signatureChanged: sigChanged,
            breakingChange: sigChanged && newDecl.isExported,
          });
        }
      }
    }

    // Phát hiện các symbol bị xóa (breaking change nếu là export)
    for (const [key, oldDecl] of oldDecls.entries()) {
      if (!newDecls.has(key)) {
        results.push({
          name: oldDecl.name,
          kind: oldDecl.kind,
          isExported: oldDecl.isExported,
          line: oldDecl.line,
          signatureChanged: true,
          breakingChange: oldDecl.isExported,
        });
      }
    }
  } catch {
    // Fallback sang regex nếu parse AST gặp lỗi cú pháp tạm thời
    return detectChangedSymbolsNonTs(oldContent, newContent);
  }

  return results;
}

interface DeclSummary {
  name: string;
  kind: ChangedSymbolInfo['kind'];
  isExported: boolean;
  line: number;
  text: string;
  signatureText: string;
}

function extractDeclarations(sourceFile: ts.SourceFile): Map<string, DeclSummary> {
  const map = new Map<string, DeclSummary>();

  const isExportedNode = (node: ts.Node): boolean => {
    if (ts.canHaveModifiers(node)) {
      const modifiers = ts.getModifiers(node);
      return Boolean(
        modifiers?.some(
          (m: ts.ModifierLike) => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword,
        ),
      );
    }
    return false;
  };

  const visit = (node: ts.Node, parentName?: string) => {
    let name = '';
    let kind: ChangedSymbolInfo['kind'] = 'unknown';
    let isExported = isExportedNode(node);
    let signatureText = '';

    if (ts.isFunctionDeclaration(node) && node.name) {
      name = node.name.text;
      kind = 'function';
      signatureText = node.parameters.map((p) => p.getText(sourceFile)).join(', ') +
        (node.type ? `: ${node.type.getText(sourceFile)}` : '');
    } else if (ts.isClassDeclaration(node) && node.name) {
      name = node.name.text;
      kind = 'class';
      signatureText = name;
    } else if (ts.isInterfaceDeclaration(node)) {
      name = node.name.text;
      kind = 'interface';
      signatureText = name;
    } else if (ts.isTypeAliasDeclaration(node)) {
      name = node.name.text;
      kind = 'type';
      signatureText = node.type.getText(sourceFile);
    } else if (ts.isEnumDeclaration(node)) {
      name = node.name.text;
      kind = 'enum';
      signatureText = name;
    } else if (ts.isMethodDeclaration(node) && node.name && parentName) {
      name = `${parentName}.${node.name.getText(sourceFile)}`;
      kind = 'method';
      signatureText = node.parameters.map((p) => p.getText(sourceFile)).join(', ');
    } else if (ts.isVariableStatement(node)) {
      const isExp = isExportedNode(node);
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const varName = decl.name.text;
          const { line } = sourceFile.getLineAndCharacterOfPosition(decl.getStart(sourceFile));
          const key = `variable:${varName}`;
          map.set(key, {
            name: varName,
            kind: 'variable',
            isExported: isExp,
            line: line + 1,
            text: decl.getText(sourceFile),
            signatureText: decl.type ? decl.type.getText(sourceFile) : '',
          });
        }
      }
    }

    if (name && kind !== 'unknown') {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const key = `${kind}:${name}`;
      map.set(key, {
        name,
        kind,
        isExported,
        line: line + 1,
        text: node.getText(sourceFile),
        signatureText,
      });
    }

    const currentParent = kind === 'class' ? name : parentName;
    ts.forEachChild(node, (child) => visit(child, currentParent));
  };

  visit(sourceFile);
  return map;
}

function detectChangedSymbolsNonTs(
  oldContent: string | undefined,
  newContent: string,
): ChangedSymbolInfo[] {
  const results: ChangedSymbolInfo[] = [];
  const regex = /(?:def|class|function)\s+([a-zA-Z0-9_$]+)/g;
  const oldSet = new Set<string>();
  if (oldContent) {
    let m: RegExpExecArray | null;
    while ((m = regex.exec(oldContent)) !== null) {
      oldSet.add(m[1]);
    }
  }

  let m: RegExpExecArray | null;
  const newRegex = /(?:def|class|function)\s+([a-zA-Z0-9_$]+)/g;
  while ((m = newRegex.exec(newContent)) !== null) {
    results.push({
      name: m[1],
      kind: 'function',
      isExported: true,
      line: newContent.slice(0, m.index).split('\n').length,
    });
  }

  return results;
}

/**
 * 2. Xây dựng hoặc lấy Reverse Dependency Graph toàn bộ Workspace
 */
export function getWorkspaceDependencyTopology(workspace: Workspace): CachedDependencyTopology {
  const now = Date.now();
  if (
    cachedTopology &&
    cachedTopology.workspaceRoot === workspace.rootDir &&
    now - cachedTopology.timestamp < 30_000 // Cache 30 giây
  ) {
    return cachedTopology;
  }

  const engine = getIntelligenceService(workspace);
  const topology = engine.getArchitectureTopology('src');
  const forwardGraph = topology.dependencyGraph;
  const reverseGraph: Record<string, string[]> = {};

  // Xây dựng reverse graph: ai import file này
  for (const [fromFile, toFiles] of Object.entries(forwardGraph)) {
    const normFrom = fromFile.replace(/\\/g, '/');
    for (const toFile of toFiles) {
      const normTo = toFile.replace(/\\/g, '/');
      if (!reverseGraph[normTo]) {
        reverseGraph[normTo] = [];
      }
      if (!reverseGraph[normTo].includes(normFrom)) {
        reverseGraph[normTo].push(normFrom);
      }
    }
  }

  const allCodeFiles = Object.keys(forwardGraph);

  cachedTopology = {
    timestamp: now,
    workspaceRoot: workspace.rootDir,
    forwardGraph,
    reverseGraph,
    allCodeFiles,
  };

  return cachedTopology;
}

export function isTestFile(file: string): boolean {
  const lower = file.toLowerCase();
  return (
    lower.includes('.test.') ||
    lower.includes('.spec.') ||
    lower.includes('test-suite') ||
    lower.includes('__tests__') ||
    lower.includes('/tests/') ||
    lower.includes('\\tests\\')
  );
}

/**
 * 3. Tính toán toàn diện Blast Radius đa tầng (Multi-hop Reverse Dependency BFS)
 */
export function calculateComprehensiveBlastRadius(params: {
  workspace: Workspace;
  filePath: string;
  symbol?: string;
  modifiedSymbols?: ChangedSymbolInfo[];
  depth?: number;
}): EnrichedBlastRadius {
  const { workspace, filePath, symbol, depth = 2 } = params;
  const maxDepth = Math.min(Math.max(1, depth), 5);
  const normTarget = workspace.toRelativePath(filePath).replace(/\\/g, '/');

  const topology = getWorkspaceDependencyTopology(workspace);
  const reverseGraph = topology.reverseGraph;

  const directConsumers = reverseGraph[normTarget] || [];
  const transitiveFilesSet = new Set<string>();
  const visited = new Set<string>([normTarget]);

  // BFS duyệt ngược đồ thị phụ thuộc theo độ sâu `depth`
  let currentLevel = [...directConsumers];
  for (const f of currentLevel) {
    visited.add(f);
    transitiveFilesSet.add(f);
  }

  for (let d = 2; d <= maxDepth; d++) {
    const nextLevel: string[] = [];
    for (const file of currentLevel) {
      const callersOfFile = reverseGraph[file] || [];
      for (const nextFile of callersOfFile) {
        if (!visited.has(nextFile)) {
          visited.add(nextFile);
          transitiveFilesSet.add(nextFile);
          nextLevel.push(nextFile);
        }
      }
    }
    currentLevel = nextLevel;
    if (currentLevel.length === 0) break;
  }

  // Danh sách test suites bị ảnh hưởng
  const impactedTestSuitesSet = new Set<string>();

  // 3a. Kiểm tra test files trong transitive graph
  for (const f of visited) {
    if (isTestFile(f)) {
      impactedTestSuitesSet.add(f);
    }
  }

  // 3b. Kiểm tra companion test files theo tên
  const parsed = path.parse(normTarget);
  const baseName = parsed.name.replace(/\.(test|spec)$/, '');
  const candidateTests = [
    `${parsed.dir}/${baseName}.test${parsed.ext}`,
    `${parsed.dir}/${baseName}.spec${parsed.ext}`,
    `${parsed.dir}/__tests__/${baseName}.test${parsed.ext}`,
    `src/__tests__/${baseName}.test${parsed.ext}`,
  ];
  for (const ct of candidateTests) {
    const normCt = ct.replace(/\\/g, '/');
    if (topology.allCodeFiles.includes(normCt) || fs.existsSync(workspace.resolveSafePath(normCt))) {
      impactedTestSuitesSet.add(normCt);
    }
  }

  // 3c. Truy vết callers cấp symbol nếu có symbol
  const callers: Array<{ name: string; file: string; line: number }> = [];
  let publicApiAffected = false;
  let breakingChange = false;

  const modifiedSymbols = params.modifiedSymbols || [];
  const targetSymbols = symbol
    ? [symbol]
    : modifiedSymbols.filter((s) => s.isExported).map((s) => s.name);

  if (modifiedSymbols.some((s) => s.isExported)) {
    publicApiAffected = true;
  }
  if (modifiedSymbols.some((s) => s.breakingChange)) {
    breakingChange = true;
  }

  const tsService = getIntelligenceService(workspace).getTypeScriptService();

  for (const sym of targetSymbols.slice(0, 5)) {
    try {
      const refs = tsService.findReferences(filePath, sym, 50);
      for (const r of refs) {
        if (!r.isDefinition) {
          const rel = workspace.toRelativePath(r.file).replace(/\\/g, '/');
          if (rel !== normTarget && !callers.some((c) => c.file === rel && c.line === r.line)) {
            callers.push({
              name: sym,
              file: rel,
              line: r.line,
            });
          }
          if (isTestFile(rel)) {
            impactedTestSuitesSet.add(rel);
          }
        }
      }
    } catch {}
  }

  // 4. Đánh giá Mức độ Rủi ro (Risk Level)
  const isCoreModule =
    normTarget.includes('kernel') ||
    normTarget.includes('security') ||
    normTarget.includes('auth') ||
    normTarget.includes('session') ||
    normTarget.includes('agent-loop') ||
    normTarget.includes('permission');

  let score = 0.15;
  if (isCoreModule) score += 0.4;
  if (publicApiAffected) score += 0.25;
  if (breakingChange) score += 0.35;
  score += Math.min(0.3, directConsumers.length * 0.05);
  score += Math.min(0.2, transitiveFilesSet.size * 0.02);

  let risk: ImpactRiskLevel = 'LOW';
  if (score >= 0.85 || (breakingChange && directConsumers.length > 0)) {
    risk = 'CRITICAL';
  } else if (score >= 0.6 || (publicApiAffected && directConsumers.length >= 3)) {
    risk = 'HIGH';
  } else if (score >= 0.35 || directConsumers.length > 0 || impactedTestSuitesSet.size > 0) {
    risk = 'MEDIUM';
  }

  const impactedTestSuites = Array.from(impactedTestSuitesSet);
  const transitiveFiles = Array.from(transitiveFilesSet);

  // 5. Sinh khuyến nghị hành động tức thì cho Agent
  const warnings: string[] = [];
  const recommendedActions: string[] = [];

  if (breakingChange) {
    warnings.push(`Phát hiện BREAKING CHANGE: Chữ ký hoặc export của symbol đã thay đổi trong "${normTarget}".`);
  }
  if (publicApiAffected && directConsumers.length > 0) {
    warnings.push(`File này có ${directConsumers.length} module tiêu thụ trực tiếp. Thay đổi có thể gây lỗi compiler.`);
  }

  recommendedActions.push('Kiểm tra compiler/diagnostics bằng "get_diagnostics" hoặc "tsc --noEmit".');
  if (impactedTestSuites.length > 0) {
    const testTargets = impactedTestSuites.slice(0, 3).join(' ');
    recommendedActions.push(`Chạy các bài kiểm thử bị ảnh hưởng: npm test -- ${testTargets}`);
  }
  if (directConsumers.length > 0) {
    recommendedActions.push(`Xác minh các module phụ thuộc trực tiếp: ${directConsumers.slice(0, 3).join(', ')}`);
  }

  return {
    risk,
    score: Number(score.toFixed(2)),
    targetFile: normTarget,
    depth: maxDepth,
    modifiedSymbols,
    directConsumers,
    transitiveFiles,
    impactedTestSuites,
    callers,
    publicApiAffected,
    breakingChange,
    warnings,
    recommendedActions,
  };
}

/**
 * 4. Helper làm giàu kết quả mutation tự động (Universal Mutation Enricher)
 */
export async function enrichMutationResultWithBlastRadius(
  toolName: string,
  args: Record<string, any>,
  result: Record<string, any>,
  workspace: Workspace,
  options?: { oldContent?: string; newContent?: string },
): Promise<Record<string, any>> {
  if (result.success === false || result.error) return result;
  if (!['replace_text', 'write_file', 'apply_patch', 'create_file'].includes(toolName)) return result;

  const rawPath = String(result.path || args.path || args.targetFile || '');
  if (!rawPath) return result;

  try {
    invalidateTopologyCache();

    let modifiedSymbols: ChangedSymbolInfo[] = [];
    if (options?.newContent) {
      modifiedSymbols = detectChangedSymbols(rawPath, options.oldContent, options.newContent);
    }

    const blast = calculateComprehensiveBlastRadius({
      workspace,
      filePath: rawPath,
      modifiedSymbols,
      depth: 2,
    });

    return {
      ...result,
      blastRadius: {
        risk: blast.risk,
        score: blast.score,
        depth: blast.depth,
        changedSymbols: blast.modifiedSymbols.map((s) => s.name),
        directConsumers: blast.directConsumers,
        transitiveFiles: blast.transitiveFiles,
        impactedTestSuites: blast.impactedTestSuites,
        callersCount: blast.callers.length,
        publicApiAffected: blast.publicApiAffected,
        breakingChange: blast.breakingChange,
        warnings: blast.warnings,
        recommendedActions: blast.recommendedActions,
      },
    };
  } catch {
    return result;
  }
}
