import type { AgentPlugin, KernelContext } from '../kernel.js';

export const SPEC_CLARIFICATION_SECTION_ID = 'spec-clarification';

export const SPEC_CLARIFICATION_POLICY = `17. SPEC CLARIFICATION VIA ask_user / ask_question (MCP ELICITATION & V2 FORM):
   - When the spec is ambiguous AND at least two viable implementations exist AND the choice blocks progress, call ask_user (or ask_question) with one precise question plus optional structured options or up to 800 characters of context — then implement the user's pick.
   - Never ask what tools can already answer: read the code, docs, and conversation first. Never repeat a question that was dismissed or unavailable.
   - A null pick (dismissed, capped, or headless) means proceed with best judgment and note the assumption in the final answer.
   - At most 2 ask_user/ask_question calls per turn; the tool enforces this cap. Batch related doubts into a single question instead of asking one by one.`;

/**
 * GrillPlugin - Model-initiated spec clarification (MCP Elicitation & V2 Form).
 * Registers the policy section together.
 */
export const GrillPlugin: AgentPlugin = {
  name: 'grill-plugin',
  version: '1.1.0',
  description: 'MCP Elicitation & V2 Form: interactive ask_user / ask_question Grill modal with structured options or LLM-suggested options',
  apply(ctx: KernelContext) {
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
