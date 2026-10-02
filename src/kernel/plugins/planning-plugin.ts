import { AgentPlugin, KernelContext } from '../kernel.js';
import { createPlanTool, createUpdatePlanTaskTool } from '../../tools/plan-tools.js';

/**
 * PlanningPlugin - Module hoá công cụ Lập kế hoạch phân rã nhiệm vụ (Plan Tree)
 */
export const PlanningPlugin: AgentPlugin = {
  name: 'planning-plugin',
  version: '1.0.0',
  description: 'Dynamic planning tools and work-progress tracking',
  apply(ctx: KernelContext) {
    ctx.registerTool(createPlanTool(ctx.plan));
    ctx.registerTool(createUpdatePlanTaskTool(ctx.plan));
  },
};
