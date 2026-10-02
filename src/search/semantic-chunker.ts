import { createHash } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
import { SemanticSlicer, type CodeSymbol } from '../agent/semantic-slicer.js';

export interface CodeGraphEdge {
  target: string;
  relation: 'calls' | 'uses_type' | 'extends' | 'implements' | 'imports';
  weight?: number;
  targetPath?: string;
}

export interface SemanticCodeChunk {
  id: string;
  path: string;
  language: string;
  kind: CodeSymbol['kind'] | 'file-window';
  name: string;
  qualifiedName: string;
  signature: string;
  startLine: number;
  endLine: number;
  sourceHash: string;
  text: string;
  embeddingText: string;
  imports: string[];
  parserConfidence: 'high' | 'low';
  outgoingCalls?: string[];
  typesReferenced?: string[];
  parentSymbol?: string;
  graphEdges?: CodeGraphEdge[];
}

export interface SemanticChunkerOptions {
  maxChunkCharacters?: number;
  fallbackWindowLines?: number;
  fallbackOverlapLines?: number;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.cs': 'csharp',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.rb': 'ruby', '.php': 'php',
};

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function chunkCodeFile(
  filePath: string,
  content: string,
  options: SemanticChunkerOptions = {},
): SemanticCodeChunk[] {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const lines = content.split('\n');
  const outline = SemanticSlicer.extractOutline(normalizedPath, content);
  const imports = outline.imports || extractImports(content);
  const language = LANGUAGE_BY_EXTENSION[path.extname(filePath).toLowerCase()] || 'text';
  const maxCharacters = clamp(options.maxChunkCharacters ?? 12_000, 1_000, 100_000);

  const chunks: SemanticCodeChunk[] = [];
  for (const symbol of outline.symbols) {
    const source = lines.slice(symbol.startLine - 1, symbol.endLine).join('\n');
    const text = source.length <= maxCharacters ? source : source.slice(0, maxCharacters);
    const sourceHash = sha256(source);
    const qualifiedName = `${normalizedPath}::${symbol.qualifiedName || symbol.name}`;
    const relations = language === 'rust' && symbol.parser === 'rust-tree-sitter'
      ? { calls: symbol.outgoingCalls || [], types: symbol.typesReferenced || [], edges: symbol.graphEdges || [] }
      : extractAstRelations(source, language, symbol.name);
    const parentSymbol = symbol.qualifiedName && symbol.qualifiedName.includes('.')
      ? symbol.qualifiedName.slice(0, symbol.qualifiedName.lastIndexOf('.'))
      : undefined;

    chunks.push({
      id: sha256(`${qualifiedName}\0${symbol.kind}\0${sourceHash}`),
      path: normalizedPath,
      language,
      kind: symbol.kind,
      name: symbol.name,
      qualifiedName,
      signature: symbol.signature,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      sourceHash,
      text,
      embeddingText: buildEmbeddingText(normalizedPath, symbol, text, imports, relations.calls, relations.types),
      imports,
      parserConfidence: symbol.confidence === 'high' ? 'high' : 'low',
      outgoingCalls: relations.calls,
      typesReferenced: relations.types,
      parentSymbol,
      graphEdges: relations.edges,
    });
  }

  if (chunks.length > 0) return chunks;

  const windowLines = clamp(options.fallbackWindowLines ?? 160, 20, 500);
  const overlapLines = clamp(options.fallbackOverlapLines ?? 20, 0, windowLines - 1);
  const step = Math.max(1, windowLines - overlapLines);
  for (let offset = 0; offset < lines.length; offset += step) {
    const endOffset = Math.min(lines.length, offset + windowLines);
    const source = lines.slice(offset, endOffset).join('\n');
    if (!source.trim()) continue;
    const sourceHash = sha256(source);
    const name = `window-${offset + 1}-${endOffset}`;
    chunks.push({
      id: sha256(`${normalizedPath}\0${name}\0${sourceHash}`),
      path: normalizedPath,
      language,
      kind: 'file-window',
      name,
      qualifiedName: `${normalizedPath}::${name}`,
      signature: lines[offset]?.trim().slice(0, 160) || name,
      startLine: offset + 1,
      endLine: endOffset,
      sourceHash,
      text: source.slice(0, maxCharacters),
      embeddingText: `path: ${normalizedPath}\nlanguage: ${language}\n${source.slice(0, maxCharacters)}`,
      imports,
      parserConfidence: 'low',
      outgoingCalls: [],
      typesReferenced: [],
      graphEdges: [],
    });
    if (endOffset >= lines.length) break;
  }
  return chunks;
}

const KEYWORD_CALL_FILTER = new Set([
  'if', 'while', 'for', 'switch', 'catch', 'function', 'return', 'throw',
  'typeof', 'instanceof', 'import', 'export', 'super', 'require', 'new',
  'async', 'await', 'case', 'break', 'continue', 'default', 'finally',
  'try', 'with', 'yield', 'let', 'const', 'var', 'print', 'len', 'range',
]);

function extractAstRelations(
  sourceCode: string,
  language: string,
  symbolName: string,
): { calls: string[]; types: string[]; edges: CodeGraphEdge[] } {
  const calls = new Set<string>();
  const types = new Set<string>();
  const edges: CodeGraphEdge[] = [];

  if (language === 'typescript' || language === 'javascript') {
    const parseCode = (code: string) => {
      try {
        const sf = ts.createSourceFile('snippet.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node)) {
            if (ts.isIdentifier(node.expression)) {
              const name = node.expression.text;
              if (!KEYWORD_CALL_FILTER.has(name) && name !== symbolName) {
                calls.add(name);
              }
            } else if (ts.isPropertyAccessExpression(node.expression)) {
              const name = node.expression.name.text;
              if (!KEYWORD_CALL_FILTER.has(name) && name !== symbolName) {
                calls.add(name);
              }
            }
          } else if (ts.isNewExpression(node)) {
            if (ts.isIdentifier(node.expression)) {
              const name = node.expression.text;
              if (!KEYWORD_CALL_FILTER.has(name) && name !== symbolName) {
                calls.add(name);
                types.add(name);
              }
            }
          } else if (ts.isTypeReferenceNode(node)) {
            if (ts.isIdentifier(node.typeName)) {
              const name = node.typeName.text;
              if (!KEYWORD_CALL_FILTER.has(name) && name !== symbolName) {
                types.add(name);
              }
            }
          } else if (ts.isHeritageClause(node)) {
            for (const type of node.types) {
              if (ts.isIdentifier(type.expression)) {
                const name = type.expression.text;
                types.add(name);
                edges.push({
                  target: name,
                  relation: node.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements',
                  weight: 1.2,
                });
              }
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(sf);
      } catch {
        // Fallback nếu snippet không khép kín
      }
    };

    parseCode(sourceCode);
    if (types.size === 0 && !sourceCode.includes('class ') && !sourceCode.includes('interface ')) {
      parseCode(`class __Wrapper__ {\n${sourceCode}\n}`);
    }
  }

  // Regex fallback cho types: : Type, as Type, <Type>
  const typeMatches = sourceCode.matchAll(/[:<]\s*([A-Z][A-Za-z0-9_]*)\b/g);
  for (const m of typeMatches) {
    const name = m[1];
    if (!KEYWORD_CALL_FILTER.has(name) && name !== symbolName && name.length >= 2) {
      types.add(name);
    }
  }

  // Regex fallback cho các hàm gọi
  if (calls.size === 0) {
    const callMatches = sourceCode.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g);
    for (const m of callMatches) {
      const name = m[1];
      if (!KEYWORD_CALL_FILTER.has(name) && name !== symbolName && name.length >= 2) {
        calls.add(name);
      }
    }
  }

  // Class inheritance (Python: class Foo(Bar):)
  const pyExtends = sourceCode.match(/class\s+[A-Za-z0-9_]+\s*\(\s*([A-Za-z0-9_]+)\s*\)/);
  if (pyExtends && pyExtends[1] && pyExtends[1] !== 'object') {
    types.add(pyExtends[1]);
    edges.push({ target: pyExtends[1], relation: 'extends', weight: 1.2 });
  }

  const callsList = Array.from(calls).slice(0, 50);
  const typesList = Array.from(types).slice(0, 30);

  for (const call of callsList) {
    if (!edges.some((e) => e.target === call && e.relation === 'calls')) {
      edges.push({ target: call, relation: 'calls', weight: 1.0 });
    }
  }

  for (const type of typesList) {
    if (!edges.some((e) => e.target === type)) {
      edges.push({ target: type, relation: 'uses_type', weight: 0.8 });
    }
  }

  return { calls: callsList, types: typesList, edges };
}

function buildEmbeddingText(
  filePath: string,
  symbol: CodeSymbol,
  source: string,
  imports: string[],
  calls: string[] = [],
  types: string[] = [],
): string {
  const leadingComment = source
    .split('\n')
    .slice(0, 8)
    .filter((line) => /^\s*(?:\/\/|\/\*|\*|#|""")/.test(line))
    .join('\n');
  return [
    `path: ${filePath}`,
    `kind: ${symbol.kind}`,
    `symbol: ${symbol.name}`,
    `signature: ${symbol.signature}`,
    imports.length > 0 ? `imports: ${imports.join(', ')}` : '',
    calls.length > 0 ? `calls: ${calls.slice(0, 10).join(', ')}` : '',
    types.length > 0 ? `types: ${types.slice(0, 10).join(', ')}` : '',
    leadingComment,
    source.slice(0, 8_000),
  ].filter(Boolean).join('\n');
}

function extractImports(content: string): string[] {
  const values = new Set<string>();
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*import\s+([A-Za-z0-9_./-]+)/gm,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) values.add(match[1]);
    }
  }
  return [...values].sort();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
