import type { AgentPlugin, KernelContext } from '../kernel.js';
import { createGrillTools } from '../../tools/grill-tools.js';

export const SPEC_CLARIFICATION_SECTION_ID = 'spec-clarification';

export const SPEC_CLARIFICATION_POLICY = `17. SPEC CLARIFICATION VIA ask_user (PROACTIVE, CAPPED):
   - When the spec is ambiguous AND at least two viable implementations exist AND the choice blocks progress, call ask_user with one precise question plus up to 800 characters of context — then implement the user's pick.
   - Never ask what tools can already answer: read the code, docs, and conversation first. Never repeat a question that was dismissed or unavailable.
   - A null pick (dismissed, capped, or headless) means proceed with best judgment and note the assumption in the final answer.
   - At most 2 ask_user calls per turn; the tool enforces this cap. Batch related doubts into a single question instead of asking one by one.`;

/**
 * GrillPlugin - Model-initiated spec clarification (Spec-as-Code).
 * Registers the ask_user tool plus its policy section together, so the
 * prompt never names a tool that is not registered.
 */
export const GrillPlugin: AgentPlugin = {
  name: 'grill-plugin',
  version: '1.0.0',
  description: 'Proactive spec clarification: model-initiated ask_user grill modal with LLM-suggested options',
  apply(ctx: KernelContext) {
    for (const tool of createGrillTools(ctx.grill)) ctx.registerTool(tool);
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
