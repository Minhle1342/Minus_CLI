import type { AgentPlugin, KernelContext } from '../kernel.js';
import type { ToolDefinition } from '../../tools/types.js';
import type { Workspace } from '../../workspace/workspace.js';
import type { ToolExecutionContext } from '../../tools/types.js';

export const SPEC_CLARIFICATION_SECTION_ID = 'spec-clarification';

export const SPEC_CLARIFICATION_POLICY = `17. SPEC CLARIFICATION & ELICITATION VIA ask_user / ask_question:
   - When encountering ANY of the following conditions, you MUST NOT guess or make unilateral assumptions; call \`ask_user\` with a focused question and 2-3 structured candidate options (with one marked as recommended):
     1. SPEC AMBIGUITY: Request is high-level, vague, or missing essential technical criteria/inputs/outputs.
     2. MULTIPLE VIABLE ARCHITECTURES: There are two or more viable implementations with distinct trade-offs.
     3. DESTRUCTIVE / IRREVERSIBLE STRATEGY: Architectural decisions with destructive data consequences (e.g. drop/reset data vs migration, wipe vs backup).
     4. TECH STACK & DEPENDENCY TRADE-OFFS: Choosing between introducing new external packages vs standard library, or performance vs simplicity trade-offs.
     5. BREAKING CHANGES & API CONTRACTS: Modifying public APIs, schemas, or CLI flags impacting external callers.
     6. SCOPE EXPANSION / DEEP UNDERLYING BUG: Discovering an issue requires major architectural refactoring instead of a local hotfix.
     7. REPO CONVENTION CONFLICTS & EDGE CASES: Conflict with existing repo conventions or unhandled business logic edge cases.
     8. ENVIRONMENT & TEST STRATEGY: Ambiguity in runtime platform (Docker vs Local) or pre-existing broken test suites.
   - Never ask what tools can already answer: read the code, docs, and conversation first. Never repeat a question that was dismissed or unavailable.
   - A null pick (dismissed, capped, or headless) means proceed with best judgment and note the assumption in the final answer.
   - At most 2 ask_user/ask_question calls per turn; the tool enforces this cap. Batch related doubts into a single question instead of asking one by one.`;

export function createAskUserTool(ctx: KernelContext): ToolDefinition {
  return {
    name: 'ask_user',
    description: 'Ask the user to clarify requirements, select between architectural approaches, or provide input when facing ambiguities or high-risk actions.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The focused question to clarify with the user.',
        },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Brief description of this option.' },
              detail: { type: 'string', description: 'Optional explanation of trade-offs or implications.' },
              recommended: { type: 'boolean', description: 'True if this is the LLM-recommended choice.' },
            },
            required: ['label'],
          },
          description: '2 to 3 candidate solutions. One should ideally have recommended: true.',
        },
      },
      required: ['question'],
    },
    async execute(args: Record<string, any>, _workspace: Workspace, context?: ToolExecutionContext): Promise<Record<string, any>> {
      const question = String(args?.question || '').trim();
      const rawOptions = Array.isArray(args?.options) ? args.options : [];
      const providedOptions = rawOptions.map((opt: any) => {
        const label = typeof opt === 'string' ? opt.trim() : String(opt?.label || opt?.text || '').trim();
        const detail = typeof opt === 'object' && opt?.detail ? String(opt.detail).trim() : undefined;
        const recommended = Boolean(opt?.recommended);
        return { label: recommended ? `[Đề xuất] ${label}` : label, detail };
      });

      const res = await ctx.grill.ask(
        question,
        { providedOptions },
        context?.sessionId,
        context?.turn,
        context?.signal,
      );

      if (res.headless) return { answer: null, headless: true };
      if (res.capped) return { answer: null, capped: true };
      if (!res.picked) return { answer: null, cancelled: true };
      return { answer: res.picked, cancelled: false };
    },
  };
}

/**
 * GrillPlugin - Model-initiated spec clarification (MCP Elicitation & V2 Form).
 * Registers the policy section together with the ask_user tool.
 */
export const GrillPlugin: AgentPlugin = {
  name: 'grill-plugin',
  version: '1.2.0',
  description: 'MCP Elicitation & V2 Form: interactive ask_user / ask_question Grill modal with structured options or LLM-suggested options',
  apply(ctx: KernelContext) {
    ctx.registerTool(createAskUserTool(ctx));
    ctx.systemPrompt.unregister(SPEC_CLARIFICATION_SECTION_ID);
    ctx.systemPrompt.register({
      id: SPEC_CLARIFICATION_SECTION_ID,
      content: SPEC_CLARIFICATION_POLICY,
      priority: 560,
    });
  },
  dispose(ctx: KernelContext) {
    ctx.systemPrompt.unregister(SPEC_CLARIFICATION_SECTION_ID);
  },
};
