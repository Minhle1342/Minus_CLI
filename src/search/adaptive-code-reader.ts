import path from 'node:path';
import { SemanticSlicer } from '../agent/semantic-slicer.js';
import {
  ContextBundlePolicy,
  type ContextCandidate,
  type ContextFidelity,
} from './context-bundle-policy.js';
import { sha256 } from './semantic-chunker.js';

export interface AdaptiveSourceFile {
  path: string;
  content: string;
  compressedContent?: string;
}

export interface FocusRange {
  path: string;
  start: number;
  end: number;
}

export interface AdaptiveCodeReadOptions {
  focusSymbols?: string[];
  focusRanges?: FocusRange[];
  previewLines?: number;
  maxTokens?: number;
  includeDirectoryStructure?: boolean;
}

export interface AdaptiveCodeSegment {
  id: string;
  path: string;
  symbol?: string;
  startLine: number;
  endLine: number;
  sourceHash: string;
  fidelity: ContextFidelity | 'directory-only';
  selectionReason: string;
  content: string;
  expandHint?: { path: string; symbol?: string; startLine?: number; endLine?: number };
}

export interface AdaptiveCodeBundle {
  segments: AdaptiveCodeSegment[];
  omitted: Array<{
    id: string;
    reason: string;
    path?: string;
    symbol?: string;
    expandHint?: AdaptiveCodeSegment['expandHint'];
  }>;
  estimatedTokens: number;
  budgetTokens: number;
  directoryStructure?: string;
  unresolvedFocusSymbols: string[];
}

export function buildAdaptiveCodeBundle(
  files: AdaptiveSourceFile[],
  options: AdaptiveCodeReadOptions = {},
): AdaptiveCodeBundle {
  const previewLines = clamp(options.previewLines ?? 24, 4, 200);
  const focusSymbols = [...new Set((options.focusSymbols || []).map((value) => value.trim()).filter(Boolean))];
  const focusRanges = normalizeRanges(options.focusRanges || []);
  const resolvedSymbols = new Set<string>();
  const candidates: ContextCandidate[] = [];
  const candidateToSegment = new Map<string, AdaptiveCodeSegment>();

  for (const file of files) {
    const normalizedPath = file.path.replace(/\\/g, '/');
    const lines = file.content.split('\n');
    const outline = SemanticSlicer.extractOutline(normalizedPath, file.content);

    for (const requested of focusSymbols) {
      const requestedName = requested.includes('::') ? requested.slice(requested.lastIndexOf('::') + 2) : requested;
      const symbol = outline.symbols.find((entry) => (
        entry.name === requestedName
        || entry.qualifiedName === requestedName
        || `${normalizedPath}::${entry.name}` === requested
        || `${normalizedPath}::${entry.qualifiedName || entry.name}` === requested
      ));
      if (!symbol) continue;
      resolvedSymbols.add(requested);
      addSegment({
        path: normalizedPath,
        symbol: symbol.name,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        content: lines.slice(symbol.startLine - 1, symbol.endLine).join('\n'),
        fidelity: 'full',
        selectionReason: 'focus_symbol',
        required: true,
        lexicalScore: 1,
      });
    }

    for (const range of focusRanges.filter((entry) => pathsEqual(entry.path, normalizedPath))) {
      const start = clamp(range.start, 1, Math.max(1, lines.length));
      const end = clamp(range.end, start, Math.max(start, lines.length));
      addSegment({
        path: normalizedPath,
        startLine: start,
        endLine: end,
        content: lines.slice(start - 1, end).join('\n'),
        fidelity: 'full',
        selectionReason: 'focus_range',
        required: true,
        lexicalScore: 1,
      });
    }

    const focusedNames = new Set(
      [...resolvedSymbols].flatMap((value) => {
        const name = value.includes('::') ? value.slice(value.lastIndexOf('::') + 2) : value;
        return [name, name.split('.').pop() || name];
      }),
    );
    for (const symbol of outline.symbols.filter((entry) => (
      !focusedNames.has(entry.name) && !focusedNames.has(entry.qualifiedName || entry.name)
    )).slice(0, 4)) {
      const half = Math.floor(previewLines / 2);
      const start = Math.max(1, symbol.startLine - half);
      const end = Math.min(lines.length, Math.max(symbol.startLine + half, Math.min(symbol.endLine, symbol.startLine + previewLines - 1)));
      addSegment({
        path: normalizedPath,
        symbol: symbol.name,
        startLine: start,
        endLine: end,
        content: lines.slice(start - 1, end).join('\n'),
        fidelity: 'preview',
        selectionReason: 'neighbor_preview',
        semanticScore: 0.2,
      });
    }

    const foldContent = file.compressedContent?.trim() || outline.summary;
    addSegment({
      path: normalizedPath,
      startLine: 1,
      endLine: lines.length,
      content: foldContent,
      fidelity: 'fold',
      selectionReason: 'repository_outline',
      semanticScore: 0.1,
    });
  }

  const selection = new ContextBundlePolicy().select(candidates, options.maxTokens ?? 8_000);
  const segments = selection.included
    .map((candidate) => candidateToSegment.get(candidate.id))
    .filter((segment): segment is AdaptiveCodeSegment => Boolean(segment));
  const directoryStructure = options.includeDirectoryStructure === false
    ? undefined
    : renderDirectoryStructure(files.map((file) => file.path));
  return {
    segments,
    omitted: selection.omitted.map((omitted) => {
      const segment = candidateToSegment.get(omitted.id);
      return {
        ...omitted,
        ...(segment ? {
          path: segment.path,
          ...(segment.symbol ? { symbol: segment.symbol } : {}),
          expandHint: segment.expandHint || {
            path: segment.path,
            ...(segment.symbol ? { symbol: segment.symbol } : {}),
            startLine: segment.startLine,
            endLine: segment.endLine,
          },
        } : {}),
      };
    }),
    estimatedTokens: selection.estimatedTokens,
    budgetTokens: selection.budgetTokens,
    ...(directoryStructure ? { directoryStructure } : {}),
    unresolvedFocusSymbols: focusSymbols.filter((symbol) => !resolvedSymbols.has(symbol)),
  };

  function addSegment(input: {
    path: string;
    symbol?: string;
    startLine: number;
    endLine: number;
    content: string;
    fidelity: ContextFidelity;
    selectionReason: string;
    required?: boolean;
    lexicalScore?: number;
    semanticScore?: number;
  }): void {
    if (!input.content.trim()) return;
    const sourceHash = sha256(input.content);
    const id = sha256(`${input.path}:${input.symbol || ''}:${input.startLine}:${input.endLine}:${sourceHash}`);
    const segment: AdaptiveCodeSegment = {
      id,
      path: input.path,
      ...(input.symbol ? { symbol: input.symbol } : {}),
      startLine: input.startLine,
      endLine: input.endLine,
      sourceHash,
      fidelity: input.fidelity,
      selectionReason: input.selectionReason,
      content: input.content,
      ...(input.fidelity !== 'full' ? {
        expandHint: {
          path: input.path,
          ...(input.symbol ? { symbol: input.symbol } : {}),
          startLine: input.startLine,
          endLine: input.endLine,
        },
      } : {}),
    };
    candidateToSegment.set(id, segment);
    candidates.push({
      id,
      path: input.path,
      ...(input.symbol ? { symbol: input.symbol } : {}),
      startLine: input.startLine,
      endLine: input.endLine,
      sourceHash,
      content: input.content,
      fidelity: input.fidelity,
      required: input.required,
      freshness: 'current',
      lexicalScore: input.lexicalScore,
      semanticScore: input.semanticScore,
      selectionReason: input.selectionReason,
    });
  }
}

function normalizeRanges(ranges: FocusRange[]): FocusRange[] {
  return ranges
    .filter((range) => range && typeof range.path === 'string' && Number.isFinite(range.start) && Number.isFinite(range.end))
    .map((range) => ({ path: range.path.replace(/\\/g, '/'), start: Math.trunc(range.start), end: Math.trunc(range.end) }))
    .filter((range) => range.start > 0 && range.end >= range.start);
}

function pathsEqual(left: string, right: string): boolean {
  const normalizedLeft = path.posix.normalize(left.replace(/\\/g, '/')).toLowerCase();
  const normalizedRight = path.posix.normalize(right.replace(/\\/g, '/')).toLowerCase();
  return normalizedLeft === normalizedRight || normalizedRight.endsWith(`/${normalizedLeft}`);
}

function renderDirectoryStructure(paths: string[]): string {
  const root: Record<string, any> = {};
  for (const filePath of [...new Set(paths.map((value) => value.replace(/\\/g, '/')))].sort()) {
    let cursor = root;
    for (const part of filePath.split('/').filter(Boolean)) cursor = cursor[part] ||= {};
  }
  const lines: string[] = [];
  const visit = (node: Record<string, any>, prefix = ''): void => {
    const entries = Object.keys(node).sort();
    entries.forEach((entry, index) => {
      const last = index === entries.length - 1;
      lines.push(`${prefix}${last ? '└─' : '├─'} ${entry}`);
      visit(node[entry], `${prefix}${last ? '   ' : '│  '}`);
    });
  };
  visit(root);
  return lines.join('\n');
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
