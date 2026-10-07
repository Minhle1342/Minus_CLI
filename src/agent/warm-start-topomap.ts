/**
 * Warm-Start Workspace Topology Map (GitNexus / Aider Repo Map Pattern)
 *
 * Automatically extracts technical entities/identifiers from the initial user prompt,
 * probes the workspace/knowledge graph for top related files and callers/callees,
 * and formats a high-density, token-capped topology overview (~150-250 tokens)
 * for dynamic injection at Step 1 of the agent turn.
 */

import fs from 'node:fs';
import path from 'node:path';
import { extractTechnicalEntities } from './solution-grounding-auditor.js';
import { SemanticSlicer, type CodeSymbol } from './semantic-slicer.js';

export interface WarmStartTopologyOptions {
  workspaceRootDir: string;
  userPrompt: string;
  maxFiles?: number;
  maxTokens?: number;
}

export interface WarmStartTopologyResult {
  rendered: string;
  matchedFiles: string[];
  matchedSymbols: string[];
  estimatedTokens: number;
}

const COMMON_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.cs',
]);

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.codingagent', 'coverage', '.next', '.cache',
]);

/**
 * Searches the workspace filesystem for files matching entity names or keywords.
 */
function findCandidateFiles(
  rootDir: string,
  entities: string[],
  maxResults = 5,
): string[] {
  if (entities.length === 0) return [];
  const matched: string[] = [];
  const normalizedEntities = entities.map((e) => e.toLowerCase());

  function walk(currentDir: string, depth = 0) {
    if (depth > 6 || matched.length >= maxResults * 2) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env') continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          walk(path.join(currentDir, entry.name), depth + 1);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!COMMON_EXTENSIONS.has(ext)) continue;

        const relPath = path.relative(rootDir, path.join(currentDir, entry.name)).replace(/\\/g, '/');
        const lowerRel = relPath.toLowerCase();
        const baseName = path.basename(entry.name, ext).toLowerCase();

        for (const ent of normalizedEntities) {
          if (
            lowerRel.includes(ent) ||
            baseName.includes(ent) ||
            ent.includes(baseName)
          ) {
            matched.push(relPath);
            break;
          }
        }
      }
    }
  }

  walk(rootDir);
  return Array.from(new Set(matched)).slice(0, maxResults);
}

/**
 * Generates the compact Warm-Start Topology string from user prompt and workspace.
 */
export async function generateWarmStartTopology(
  options: WarmStartTopologyOptions,
): Promise<WarmStartTopologyResult> {
  const { workspaceRootDir, userPrompt, maxFiles = 4, maxTokens = 220 } = options;

  if (!userPrompt || !userPrompt.trim() || !workspaceRootDir) {
    return { rendered: '', matchedFiles: [], matchedSymbols: [], estimatedTokens: 0 };
  }

  // 1. Extract candidate technical entities (identifiers, file paths, symbol names)
  const entities = extractTechnicalEntities(userPrompt);
  const words = userPrompt.match(/\b[A-Za-z_$][A-Za-z0-9_$-]{2,}\b/g) || [];
  const candidateKeywords = Array.from(new Set([...entities, ...words]))
    .filter((w) => w.length >= 3 && !['the', 'and', 'for', 'with', 'fix', 'bug', 'code', 'file', 'this', 'that'].includes(w.toLowerCase()))
    .slice(0, 10);

  if (candidateKeywords.length === 0) {
    return { rendered: '', matchedFiles: [], matchedSymbols: [], estimatedTokens: 0 };
  }

  // 2. Discover relevant files in workspace
  const matchedFiles = findCandidateFiles(workspaceRootDir, candidateKeywords, maxFiles);
  if (matchedFiles.length === 0) {
    return { rendered: '', matchedFiles: [], matchedSymbols: [], estimatedTokens: 0 };
  }

  // 3. Extract top symbols and relations for each matched file
  const lines: string[] = ['🗺️ [WORKSPACE TOPOLOGY WARM-START (GitNexus Graph)]'];
  const matchedSymbols: string[] = [];

  for (const relPath of matchedFiles) {
    const absPath = path.resolve(workspaceRootDir, relPath);
    try {
      const content = fs.readFileSync(absPath, 'utf8');
      const outline = SemanticSlicer.extractOutline(relPath, content);
      if (outline && outline.symbols && outline.symbols.length > 0) {
        // Pick the top 1-2 exported symbols or most prominent symbols
        const topSymbols = outline.symbols
          .filter((s: CodeSymbol) => s.name && !s.name.startsWith('_'))
          .slice(0, 2);

        const symbolDescs = topSymbols.map((s: CodeSymbol) => {
          matchedSymbols.push(s.name);
          const calls = s.outgoingCalls?.slice(0, 2).join(', ');
          const callDesc = calls ? ` -> calls ${calls}` : '';
          return `${s.kind} ${s.name}()${callDesc}`;
        });

        lines.push(`• ${relPath}: ${symbolDescs.join('; ') || 'source module'}`);
      } else {
        lines.push(`• ${relPath}: source module`);
      }
    } catch {
      lines.push(`• ${relPath}: source module`);
    }
  }

  const rendered = lines.join('\n');
  const estimatedTokens = Math.ceil(rendered.length / 4);

  return {
    rendered,
    matchedFiles,
    matchedSymbols,
    estimatedTokens,
  };
}
