import type { AgentPlugin, KernelContext } from '../kernel.js';
import { createCodeGraphTools } from '../../tools/codegraph-tools.js';

export const CODEGRAPH_PROMPT_SECTION_ID = 'codegraph-usage-policy';

export const CODEGRAPH_USAGE_POLICY = `CODEGRAPH SEMANTIC CODE INTELLIGENCE POLICY (OVERRIDES DEFAULT SEARCH FLOW)

Khi project đã có \`.codegraph/\` index, CodeGraph là pre-built knowledge graph thay thế
grep + Read loop — tuân thủ thứ tự sau thay vì flow tìm kiếm mặc định:

1. codegraph_explore TRƯỚC TIÊN cho mọi câu hỏi cấu trúc ("how does X work", flow X→Y,
   survey khu vực, bug cần trace) và TRƯỚC MỌI EDIT. 1 call trả source + call paths
   (kể cả dynamic-dispatch hops mà grep không theo được) + blast radius.
2. KHÔNG grep / Read / search_codebase_fast trước để "tìm" code đã index — đó là
   làm lại việc graph đã làm, tốn tool calls. Coi source trả về như đã đọc file,
   không re-verify bằng grep (AST parse chính xác hơn grep).
3. Đào sâu bằng codegraph_node (1 symbol/file + caller/callee trail), codegraph_callers/
   callees cho edges, codegraph_impact trước khi sửa.
4. Chỉ Read trực tiếp khi: (a) response có staleness banner nêu tên file (graph lag
   ~2s sau edit), (b) file ngoài index (config, docs), (c) codegraph_status báo
   indexed=false — khi đó fallback search_codebase_fast / grep / read_file và gợi ý
   \`codegraph init\`. Không tự chạy init/sync khi chưa được user cho phép.`;

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
