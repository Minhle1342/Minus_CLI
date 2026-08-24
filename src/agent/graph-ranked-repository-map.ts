import fs from 'node:fs/promises';
import path from 'node:path';
import type { Workspace } from '../workspace/workspace.js';
import { SemanticSlicer, type CodeSymbol } from './semantic-slicer.js';

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.php', '.rb', '.swift', '.kt', '.kts',
]);
const IDENTIFIER_PATTERN = /[A-Za-z_$][A-Za-z0-9_$-]*/g;
const MUTATION_TOOLS = new Set([
  'write_file', 'create_file', 'replace_text', 'apply_patch', 'delete_file', 'move_file',
]);
const MAX_INDEXED_FILES = 5_000;
const MAX_INDEXED_SOURCE_BYTES = 64 * 1024 * 1024;

interface RepositoryFileNode {
  path: string;
  absolutePath: string;
  content: string;
  symbols: CodeSymbol[];
  identifierCounts: Map<string, number>;
}

export interface RankedRepositoryEntry {
  path: string;
  score: number;
  dependencyScore: number;
  impactScore: number;
  lexicalScore: number;
  symbols: CodeSymbol[];
}

export interface RepositoryMapResult {
  rendered: string;
  entries: RankedRepositoryEntry[];
  indexedFiles: number;
  indexedSymbols: number;
  graphEdges: number;
  estimatedTokens: number;
  tokenBudget: number;
  refreshed: boolean;
}

export interface RepositoryMapOptions {
  maxTokens?: number;
  seedFiles?: string[];
  seedSymbols?: string[];
  maxFiles?: number;
}

interface RepositorySnapshot {
  files: RepositoryFileNode[];
  edges: Map<string, Map<string, number>>;
  fingerprint: string;
  builtAt: number;
  symbolCount: number;
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function tokenize(value: string): Set<string> {
  return new Set(
    (value.match(IDENTIFIER_PATTERN) || [])
      .map((token) => token.toLowerCase())
      .filter((token) => token.length >= 2),
  );
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 3.8);
}

/**
 * A task-personalized, bidirectional PageRank repository map.
 *
 * The service deliberately reuses Minus' semantic outlines and import graph
 * instead of introducing another parser runtime. It ranks both dependencies
 * (what the active code uses) and dependents (what a change may affect), then
 * emits only signatures that fit the active token budget.
 */
export class GraphRankedRepositoryMap {
  private workspace: Workspace;
  private snapshot?: RepositorySnapshot;
  private dirty = true;
  private changedFiles = new Set<string>();
  private diagnosticFiles = new Set<string>();

  constructor(workspace: Workspace) {
    this.workspace = workspace;
  }

  setWorkspace(workspace: Workspace): void {
    if (path.resolve(workspace.rootDir) === path.resolve(this.workspace.rootDir)) return;
    this.workspace = workspace;
    this.snapshot = undefined;
    this.dirty = true;
    this.changedFiles.clear();
    this.diagnosticFiles.clear();
  }

  invalidate(filePath?: string): void {
    this.dirty = true;
    if (filePath) this.changedFiles.add(normalizePath(filePath));
  }

  observeToolResult(toolName: string, args: Record<string, any>, result: Record<string, any>): void {
    const candidates = [
      args.path,
      args.fromPath,
      args.toPath,
      ...(Array.isArray(result.changedFiles) ? result.changedFiles : []),
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        this.changedFiles.add(normalizePath(candidate.trim()));
      }
    }
    if (MUTATION_TOOLS.has(toolName) && !result.error && !result.errorCode) this.dirty = true;

    const collectDiagnosticPaths = (value: unknown, depth = 0): void => {
      if (depth > 4 || value === null || value === undefined) return;
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 100)) collectDiagnosticPaths(item, depth + 1);
        return;
      }
      if (typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      for (const key of ['file', 'path', 'filePath']) {
        const candidate = record[key];
        if (typeof candidate === 'string' && CODE_EXTENSIONS.has(path.extname(candidate).toLowerCase())) {
          this.diagnosticFiles.add(normalizePath(candidate));
        }
      }
      for (const nested of Object.values(record)) collectDiagnosticPaths(nested, depth + 1);
    };
    collectDiagnosticPaths(result);
  }

  async build(query: string, options: RepositoryMapOptions = {}): Promise<RepositoryMapResult> {
    const { snapshot, refreshed } = await this.ensureSnapshot();
    const tokenBudget = Math.max(256, Math.min(12_000, options.maxTokens ?? 1_600));
    const maxFiles = Math.max(1, Math.min(100, options.maxFiles ?? 24));
    if (snapshot.files.length === 0) {
      return {
        rendered: '', entries: [], indexedFiles: 0, indexedSymbols: 0,
        graphEdges: 0, estimatedTokens: 0, tokenBudget, refreshed,
      };
    }

    const queryTokens = tokenize(query);
    const explicitSeeds = new Set([
      ...(options.seedFiles || []),
      ...this.changedFiles,
      ...this.diagnosticFiles,
    ].map(normalizePath));
    const symbolSeeds = new Set((options.seedSymbols || []).map((item) => item.toLowerCase()));
    for (const token of queryTokens) symbolSeeds.add(token);

    const personalization = new Map<string, number>();
    const lexicalScores = new Map<string, number>();
    for (const file of snapshot.files) {
      const lowerPath = file.path.toLowerCase();
      const symbolNames = file.symbols.map((symbol) => symbol.name.toLowerCase());
      let lexical = 0;
      for (const token of queryTokens) {
        if (lowerPath.includes(token)) lexical += 2;
        if (symbolNames.some((name) => name === token)) lexical += 6;
        else if (symbolNames.some((name) => name.includes(token))) lexical += 2;
      }
      if ([...explicitSeeds].some((seed) => lowerPath === seed.toLowerCase() || lowerPath.endsWith(`/${seed.toLowerCase()}`))) {
        lexical += 16;
      }
      if (symbolNames.some((name) => symbolSeeds.has(name))) lexical += 10;
      lexicalScores.set(file.path, lexical);
      if (lexical > 0) personalization.set(file.path, 1 + lexical);
    }

    const dependencyRank = this.pageRank(snapshot.files, snapshot.edges, personalization, false);
    const impactRank = this.pageRank(snapshot.files, snapshot.edges, personalization, true);
    const maxLexical = Math.max(1, ...lexicalScores.values());
    const ranked = snapshot.files.map((file): RankedRepositoryEntry => {
      const lexicalScore = (lexicalScores.get(file.path) || 0) / maxLexical;
      const dependencyScore = dependencyRank.get(file.path) || 0;
      const impactScore = impactRank.get(file.path) || 0;
      return {
        path: file.path,
        score: dependencyScore * 0.52 + impactScore * 0.33 + lexicalScore * 0.15,
        dependencyScore,
        impactScore,
        lexicalScore,
        symbols: [...file.symbols],
      };
    }).sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));

    const fileByPath = new Map(snapshot.files.map((file) => [file.path, file]));
    const graphEdges = [...snapshot.edges.values()].reduce((sum, outgoing) => sum + outgoing.size, 0);
    const header = [
      '[GRAPH-RANKED REPOSITORY MAP - TASK PERSONALIZED]',
      `Indexed ${snapshot.files.length} files, ${snapshot.symbolCount} symbols, ${graphEdges} dependency edges.`,
      'Ranking blends downstream dependencies, reverse blast-radius impact, active-task terms, changed files, and diagnostic anchors.',
    ];
    const selected: RankedRepositoryEntry[] = [];
    const sections: string[] = [];
    let usedTokens = estimateTokens(`${header.join('\n')}\nBudget: 00000/00000 estimated tokens.\n`);
    for (const entry of ranked.slice(0, maxFiles)) {
      const node = fileByPath.get(entry.path)!;
      const orderedSymbols = [...node.symbols].sort((left, right) => {
        const leftSeeded = symbolSeeds.has(left.name.toLowerCase()) ? 1 : 0;
        const rightSeeded = symbolSeeds.has(right.name.toLowerCase()) ? 1 : 0;
        return rightSeeded - leftSeeded || left.startLine - right.startLine;
      });
      const signatureLines = orderedSymbols.slice(0, 18).map(
        (symbol) => `  L${symbol.startLine} ${symbol.signature}`,
      );
      const section = [
        `${entry.path}:  # rank=${entry.score.toFixed(4)} dependency=${entry.dependencyScore.toFixed(4)} impact=${entry.impactScore.toFixed(4)}`,
        ...(signatureLines.length > 0 ? signatureLines : ['  (no high-level symbols detected)']),
      ].join('\n');
      const sectionTokens = estimateTokens(`${section}\n`);
      if (usedTokens + sectionTokens > tokenBudget) continue;
      sections.push(section);
      selected.push(entry);
      usedTokens += sectionTokens;
    }

    const rendered = sections.length === 0 ? '' : [
      ...header,
      `Budget: ${usedTokens}/${tokenBudget} estimated tokens.`,
      ...sections,
    ].join('\n');
    return {
      rendered,
      entries: selected,
      indexedFiles: snapshot.files.length,
      indexedSymbols: snapshot.symbolCount,
      graphEdges,
      estimatedTokens: estimateTokens(rendered),
      tokenBudget,
      refreshed,
    };
  }

  async renderContext(query: string, options: RepositoryMapOptions = {}): Promise<string> {
    return (await this.build(query, options)).rendered;
  }

  private async ensureSnapshot(): Promise<{ snapshot: RepositorySnapshot; refreshed: boolean }> {
    const now = Date.now();
    if (this.snapshot && !this.dirty && now - this.snapshot.builtAt < 60_000) {
      return { snapshot: this.snapshot, refreshed: false };
    }
    const scanned = await this.scanWorkspace();
    if (this.snapshot && !this.dirty && scanned.fingerprint === this.snapshot.fingerprint) {
      this.snapshot.builtAt = now;
      return { snapshot: this.snapshot, refreshed: false };
    }
    const snapshot = this.buildSnapshot(scanned.files, scanned.fingerprint);
    this.snapshot = snapshot;
    this.dirty = false;
    return { snapshot, refreshed: true };
  }

  private async scanWorkspace(): Promise<{ files: RepositoryFileNode[]; fingerprint: string }> {
    const files: RepositoryFileNode[] = [];
    const fingerprints: string[] = [];
    let indexedBytes = 0;
    const visit = async (directory: string): Promise<void> => {
      if (files.length >= MAX_INDEXED_FILES || indexedBytes >= MAX_INDEXED_SOURCE_BYTES) return;
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (files.length >= MAX_INDEXED_FILES || indexedBytes >= MAX_INDEXED_SOURCE_BYTES) break;
        if (entry.name.startsWith('.') && entry.name !== '.github') continue;
        if (entry.isDirectory() && this.workspace.isIgnoredDirectory(entry.name)) continue;
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(absolutePath);
          continue;
        }
        const extension = path.extname(entry.name).toLowerCase();
        if (!entry.isFile() || !CODE_EXTENSIONS.has(extension)) continue;
        try {
          const stat = await fs.stat(absolutePath);
          if (stat.size > 400 * 1024 || indexedBytes + stat.size > MAX_INDEXED_SOURCE_BYTES) continue;
          const content = await fs.readFile(absolutePath, 'utf8');
          const relativePath = normalizePath(this.workspace.toRelativePath(absolutePath));
          const symbols = SemanticSlicer.extractOutline(relativePath, content).symbols;
          const identifierCounts = new Map<string, number>();
          for (const identifier of content.match(IDENTIFIER_PATTERN) || []) {
            identifierCounts.set(identifier, (identifierCounts.get(identifier) || 0) + 1);
          }
          files.push({ path: relativePath, absolutePath, content, symbols, identifierCounts });
          indexedBytes += stat.size;
          fingerprints.push(`${relativePath}:${stat.size}:${stat.mtimeMs}`);
        } catch {
          // A transiently unreadable file must not invalidate the usable map.
        }
      }
    };
    await visit(this.workspace.rootDir);
    return { files, fingerprint: fingerprints.join('|') };
  }

  private buildSnapshot(files: RepositoryFileNode[], fingerprint: string): RepositorySnapshot {
    const edges = new Map<string, Map<string, number>>();
    const filePaths = new Set(files.map((file) => file.path));
    const definitions = new Map<string, Set<string>>();
    for (const file of files) {
      edges.set(file.path, new Map());
      for (const symbol of file.symbols) {
        const definers = definitions.get(symbol.name) || new Set<string>();
        definers.add(file.path);
        definitions.set(symbol.name, definers);
      }
    }

    const addEdge = (from: string, to: string, weight: number): void => {
      if (from === to || !filePaths.has(from) || !filePaths.has(to)) return;
      const outgoing = edges.get(from)!;
      outgoing.set(to, (outgoing.get(to) || 0) + weight);
    };

    for (const file of files) {
      const importPattern = /(?:import|export\s+(?:\{|\*))\s+(?:[^'"`]*?\s+from\s+)?['"`]([^'"`]+)['"`]|require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
      let match: RegExpExecArray | null;
      while ((match = importPattern.exec(file.content)) !== null) {
        const specifier = match[1] || match[2];
        if (!specifier?.startsWith('.')) continue;
        const target = this.resolveImport(file.path, specifier, filePaths);
        if (target) addEdge(file.path, target, 8);
      }

      for (const [identifier, count] of file.identifierCounts) {
        const definers = definitions.get(identifier);
        if (!definers || definers.size === 0 || definers.has(file.path) && definers.size === 1) continue;
        const ambiguityPenalty = definers.size > 5 ? 0.1 : 1;
        const shapedIdentifier = identifier.length >= 8 && (identifier.includes('_') || identifier.includes('-') || /[a-z][A-Z]/.test(identifier));
        const shapeMultiplier = shapedIdentifier ? 2 : 1;
        for (const definer of definers) {
          addEdge(file.path, definer, Math.sqrt(count) * ambiguityPenalty * shapeMultiplier);
        }
      }
    }

    return {
      files,
      edges,
      fingerprint,
      builtAt: Date.now(),
      symbolCount: files.reduce((sum, file) => sum + file.symbols.length, 0),
    };
  }

  private resolveImport(fromFile: string, specifier: string, files: Set<string>): string | undefined {
    const base = normalizePath(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier)));
    const baseExtension = path.posix.extname(base).toLowerCase();
    const extensionlessBase = CODE_EXTENSIONS.has(baseExtension)
      ? base.slice(0, -baseExtension.length)
      : base;
    const candidates = [
      base,
      ...[...CODE_EXTENSIONS].map((extension) => `${extensionlessBase}${extension}`),
      ...[...CODE_EXTENSIONS].map((extension) => `${extensionlessBase}/index${extension}`),
    ];
    return candidates.find((candidate) => files.has(candidate));
  }

  private pageRank(
    files: RepositoryFileNode[],
    edges: Map<string, Map<string, number>>,
    personalization: Map<string, number>,
    reverse: boolean,
  ): Map<string, number> {
    const nodes = files.map((file) => file.path);
    const size = nodes.length;
    const graph = reverse ? this.reverseEdges(nodes, edges) : edges;
    const teleport = new Map<string, number>();
    const personalizationTotal = [...personalization.values()].reduce((sum, value) => sum + value, 0);
    for (const node of nodes) {
      teleport.set(node, personalizationTotal > 0 ? (personalization.get(node) || 0) / personalizationTotal : 1 / size);
    }
    let rank = new Map(nodes.map((node) => [node, 1 / size]));
    const damping = 0.85;
    for (let iteration = 0; iteration < 30; iteration++) {
      const next = new Map(nodes.map((node) => [node, (1 - damping) * (teleport.get(node) || 0)]));
      let danglingMass = 0;
      for (const source of nodes) {
        const outgoing = graph.get(source) || new Map<string, number>();
        const totalWeight = [...outgoing.values()].reduce((sum, weight) => sum + weight, 0);
        if (totalWeight <= 0) {
          danglingMass += rank.get(source) || 0;
          continue;
        }
        for (const [target, weight] of outgoing) {
          next.set(target, (next.get(target) || 0) + damping * (rank.get(source) || 0) * weight / totalWeight);
        }
      }
      for (const node of nodes) {
        next.set(node, (next.get(node) || 0) + damping * danglingMass * (teleport.get(node) || 0));
      }
      rank = next;
    }
    return rank;
  }

  private reverseEdges(nodes: string[], edges: Map<string, Map<string, number>>): Map<string, Map<string, number>> {
    const reversed = new Map(nodes.map((node) => [node, new Map<string, number>()]));
    for (const [source, outgoing] of edges) {
      for (const [target, weight] of outgoing) {
        const reverseOutgoing = reversed.get(target)!;
        reverseOutgoing.set(source, (reverseOutgoing.get(source) || 0) + weight);
      }
    }
    return reversed;
  }
}
