import type { AgentPlugin, KernelContext } from '../kernel.js';
import { createCodeGraphTools } from '../../tools/codegraph-tools.js';

export const CODEGRAPH_PROMPT_SECTION_ID = 'codegraph-usage-policy';

export const CODEGRAPH_USAGE_POLICY = `CODEGRAPH SEMANTIC CODE INTELLIGENCE POLICY (OVERRIDES DEFAULT SEARCH FLOW)

When the project has a \`.codegraph/\` index, CodeGraph is the pre-built knowledge graph
that replaces the grep + Read loop — follow this order instead of the default search flow:

1. Call codegraph_explore FIRST for every structural question ("how does X work", flow X→Y,
   surveying an area, bug tracing) and BEFORE EVERY EDIT. One call returns source + call paths
   (including dynamic-dispatch hops grep cannot follow) + blast radius.
2. Do NOT grep / Read / search_codebase_fast first to "find" indexed code — that redo
   work the graph already did and wastes tool calls. Treat returned source as already-read
   files; do not re-verify with grep (AST parsing is more accurate than grep).
3. Go deeper with codegraph_node (one symbol/file + caller/callee trail), codegraph_callers/
   callees for edges, codegraph_impact before modifying code.
4. Read files directly only when: (a) the response carries a staleness banner naming files
   (graph lags ~2s after edits), (b) the file is outside the index (configs, docs),
   (c) codegraph_status reports indexed=false — then fall back to search_codebase_fast /
   grep / read_file and suggest \`codegraph init\`. Never run init/sync without user approval.`;

export const CodeGraphPlugin: AgentPlugin = {
  name: 'codegraph-plugin',
  version: '1.0.0',
  description: 'Semantic code intelligence qua CodeGraph CLI (explore/node/search/callers/callees/impact/status)',
  apply(ctx: KernelContext) {
    if (String(process.env.MINUS_CODEGRAPH || '1') === '0') return;
    for (const tool of createCodeGraphTools()) {
      if (!ctx.tools.get(tool.name)) ctx.registerTool(tool);
    }
    ctx.systemPrompt.unregister(CODEGRAPH_PROMPT_SECTION_ID);
    ctx.systemPrompt.register({
      id: CODEGRAPH_PROMPT_SECTION_ID,
      content: CODEGRAPH_USAGE_POLICY,
      priority: -90,
    });
  },
  dispose(ctx: KernelContext) {
    ctx.systemPrompt.unregister(CODEGRAPH_PROMPT_SECTION_ID);
  },
};
