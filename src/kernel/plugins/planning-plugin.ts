import { AgentPlugin, KernelContext } from '../kernel.js';
import { createPlanTool, createUpdatePlanTaskTool } from '../../tools/plan-tools.js';

/**
 * PlanningPlugin - Module hoá công cụ Lập kế hoạch phân rã nhiệm vụ (Plan Tree)
 */
export const PlanningPlugin: AgentPlugin = {
  name: 'planning-plugin',
  version: '1.0.0',
  description: 'Cung cấp công cụ lập kế hoạch động và theo dõi tiến độ công việc',
  apply(ctx: KernelContext) {
    ctx.registerTool(createPlanTool(ctx.plan));
    ctx.registerTool(createUpdatePlanTaskTool(ctx.plan));
  },
};
