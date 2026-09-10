import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildAdaptiveCodeBundle } from '../search/adaptive-code-reader.js';
import { CodeSearchEngine } from '../search/code-search-engine.js';
import { SemanticCodeIndex } from '../search/semantic-code-index.js';
import { fuseSearchResults } from '../search/hybrid-ranker.js';
import { SemanticSlicer } from '../agent/semantic-slicer.js';

interface RetrievalTask {
  query: string;
  path: string;
  symbol?: string;
}

const TASKS: RetrievalTask[] = [
  { query: 'find source code by exact identifiers with BM25 fuzzy fallback', path: 'src/search/code-search-engine.ts', symbol: 'CodeSearchEngine' },
  { query: 'read compressed repository code and reveal one focused function body', path: 'src/tools/repomix-tool.ts', symbol: 'createReadCompressedCodeTool' },
  { query: 'control the total token budget of dynamic evidence', path: 'src/agent/dynamic-context-arbiter.ts', symbol: 'DynamicContextArbiter' },
  { query: 'rank repository signatures using import graph and page rank', path: 'src/agent/graph-ranked-repository-map.ts', symbol: 'GraphRankedRepositoryMap' },
  { query: 'retrieve relevant memories from previous conversation turns', path: 'src/context/turn-memory-retriever.ts', symbol: 'TurnMemoryRetriever' },
  { query: 'assemble deterministic sections into the system prompt', path: 'src/llm/prompt-assembler.ts', symbol: 'PromptAssembler' },
  { query: 'translate and stream messages to the Anthropic API', path: 'src/llm/anthropic.ts', symbol: 'AnthropicLLM' },
  { query: 'route OpenAI compatible requests to DeepSeek', path: 'src/llm/deepseek.ts', symbol: 'DeepseekLLM' },
  { query: 'extract class and function outlines from large source files', path: 'src/agent/semantic-slicer.ts', symbol: 'SemanticSlicer' },
  { query: 'validate tool input and output schemas at runtime', path: 'src/tools/schema-validator.ts' },
  { query: 'prevent unsafe file paths from escaping the workspace', path: 'src/workspace/workspace.ts', symbol: 'Workspace' },
  { query: 'compact old session history before model context overflows', path: 'src/agent/context-compactor.ts', symbol: 'ContextCompactor' },
];

async function main(): Promise<void> {
  const workspaceDir = path.resolve(process.argv.find((arg) => arg.startsWith('--workspace='))?.slice(12) || process.cwd());
  const lexical = new CodeSearchEngine(workspaceDir);
  const semantic = new SemanticCodeIndex(workspaceDir);
  const lexicalLatencies: number[] = [];
  const hybridLatencies: number[] = [];
  let lexicalRecall = 0;
  let hybridRecall = 0;
  let oldSecondReads = 0;
  let adaptiveSecondReads = 0;

  for (const task of TASKS) {
    const lexicalStart = performance.now();
    const lexicalHits = await lexical.search(task.query, { limit: 40 });
    lexicalLatencies.push(performance.now() - lexicalStart);
    if (lexicalHits.slice(0, 10).some((hit) => hit.path === task.path)) lexicalRecall++;

    const hybridStart = performance.now();
    const semanticHits = await semantic.search(task.query, { limit: 40, graphExpansion: 'auto' });
    const hybridHits = fuseSearchResults(task.query, lexicalHits, semanticHits, 10);
    hybridLatencies.push(performance.now() - hybridStart);
    if (hybridHits.some((hit) => hit.path === task.path)) hybridRecall++;

    if (task.symbol) {
      oldSecondReads++;
      const content = await fs.readFile(path.join(workspaceDir, task.path), 'utf8');
      const bundle = buildAdaptiveCodeBundle([{
        path: task.path,
        content,
        compressedContent: SemanticSlicer.extractOutline(task.path, content).summary,
      }], { focusSymbols: [task.symbol], maxTokens: 20_000 });
      if (!bundle.segments.some((segment) => segment.symbol === task.symbol && segment.fidelity === 'full')) {
        adaptiveSecondReads++;
      }
    }
  }

  const report = {
    corpus: { tasks: TASKS.length, workspace: workspaceDir },
    retrieval: {
      lexicalRecallAt10: round(lexicalRecall / TASKS.length),
      hybridRecallAt10: round(hybridRecall / TASKS.length),
      relativeRecallChange: lexicalRecall > 0 ? round((hybridRecall - lexicalRecall) / lexicalRecall) : null,
      lexicalLatencyMs: summarize(lexicalLatencies),
      hybridLatencyMs: summarize(hybridLatencies),
    },
    adaptiveReading: {
      oldSecondReads,
      adaptiveSecondReads,
      reduction: oldSecondReads > 0 ? round((oldSecondReads - adaptiveSecondReads) / oldSecondReads) : 0,
    },
    semanticIndex: semantic.getDiagnostics(),
    note: 'Repository-local deterministic proxy. Use a held-out issue/commit corpus before production rollout.',
  };
  console.log(JSON.stringify(report, null, 2));

  if (process.argv.includes('--assert')) {
    if (hybridRecall < lexicalRecall) process.exitCode = 1;
    if (adaptiveSecondReads > Math.floor(oldSecondReads * 0.6)) process.exitCode = 1;
  }
}

function summarize(values: number[]): { p50: number; p95: number; mean: number } {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (ratio: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] || 0;
  return {
    p50: round(percentile(0.5)),
    p95: round(percentile(0.95)),
    mean: round(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)),
  };
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
