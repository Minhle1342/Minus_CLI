import { createHash } from 'node:crypto';
import path from 'node:path';
import { SemanticSlicer, type CodeSymbol } from '../agent/semantic-slicer.js';

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
  const imports = extractImports(content);
  const language = LANGUAGE_BY_EXTENSION[path.extname(filePath).toLowerCase()] || 'text';
  const maxCharacters = clamp(options.maxChunkCharacters ?? 12_000, 1_000, 100_000);

  const chunks: SemanticCodeChunk[] = [];
  for (const symbol of outline.symbols) {
    const source = lines.slice(symbol.startLine - 1, symbol.endLine).join('\n');
    const text = source.length <= maxCharacters ? source : source.slice(0, maxCharacters);
    const sourceHash = sha256(source);
    const qualifiedName = `${normalizedPath}::${symbol.qualifiedName || symbol.name}`;
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
      embeddingText: buildEmbeddingText(normalizedPath, symbol, text, imports),
      imports,
      parserConfidence: language === 'typescript' || language === 'javascript' || language === 'python' ? 'high' : 'low',
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
    });
    if (endOffset >= lines.length) break;
  }
  return chunks;
}

function buildEmbeddingText(
  filePath: string,
  symbol: CodeSymbol,
  source: string,
  imports: string[],
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
