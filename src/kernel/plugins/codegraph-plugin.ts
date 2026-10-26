import type { AgentPlugin, KernelContext } from '../kernel.js';
import fs from 'node:fs';
import path from 'node:path';

export const CODEGRAPH_PROMPT_SECTION_ID = 'codegraph-usage-policy';

export const CODEGRAPH_USAGE_POLICY = `CODEGRAPH SEMANTIC CODE INTELLIGENCE POLICY (OVERRIDES DEFAULT SEARCH FLOW)

When the project has a \`.codegraph/\` index, CodeGraph is the pre-built knowledge graph
that replaces manual grep loops — use \`run_command\` with the CodeGraph CLI:

1. Run \`codegraph explore <symbol>\` via \`run_command\` FIRST for structural questions ("how does X work",
   flow X→Y, surveying an area, bug tracing) and BEFORE EDITING. One call returns source + call paths + blast radius.
2. Go deeper with \`codegraph node <symbol>\` (caller/callee trail) or \`codegraph impact <symbol>\` before modifying code.
3. Read files directly with \`read_file\` when the file is outside the index or was edited after the last index sync.
4. Never run \`codegraph init\` or \`codegraph sync\` without user approval.`;

export const CodeGraphPlugin: AgentPlugin = {
  name: 'codegraph-plugin',
  version: '1.0.0',
  description: 'Semantic code intelligence qua CodeGraph CLI (explore/node/search/callers/callees/impact/status)',
  apply(ctx: KernelContext) {
    if (String(process.env.MINUS_CODEGRAPH || '1') === '0') return;
    const codegraphDir = path.join(ctx.workspace.rootDir, '.codegraph');
    if (fs.existsSync(codegraphDir)) {
      ctx.systemPrompt.unregister(CODEGRAPH_PROMPT_SECTION_ID);
      ctx.systemPrompt.register({
        id: CODEGRAPH_PROMPT_SECTION_ID,
        content: CODEGRAPH_USAGE_POLICY,
        priority: -90,
      });
    } else {
      ctx.systemPrompt.unregister(CODEGRAPH_PROMPT_SECTION_ID);
    }
  },
  dispose(ctx: KernelContext) {
    ctx.systemPrompt.unregister(CODEGRAPH_PROMPT_SECTION_ID);
  },
};
