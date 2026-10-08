/**
 * Shadow bridge: mirror local PlanManager graph to Conductor WITHOUT
 * changing local execution. Local DAG remains source of truth.
 *
 * Usage (manual, opt-in):
 *   import { exportPlanToConductor } from './conductor/conductor-bridge.js';
 *   await exportPlanToConductor(planManager.getTaskGraph(), { dryRun: true });
 */
import {
  buildConductorWorkflow,
  type ConductorPlanGraph,
  type ConductorWorkflowDef,
} from './conductor-workflow.js';
import {
  isConductorEnabled,
  registerWorkflow,
  startWorkflow,
} from './conductor-client.js';

export interface ExportPlanResult {
  mode: 'disabled' | 'dry-run' | 'mirrored';
  workflow: ConductorWorkflowDef;
  workflowId?: string;
}

export async function exportPlanToConductor(
  graph: ConductorPlanGraph,
  opts: { dryRun?: boolean; workflowName?: string; startInput?: Record<string, unknown> } = {},
): Promise<ExportPlanResult> {
  const workflow = buildConductorWorkflow(graph, opts.workflowName);
  if (!isConductorEnabled() || opts.dryRun) {
    return { mode: isConductorEnabled() ? 'dry-run' : 'disabled', workflow };
  }
  await registerWorkflow(workflow);
  const workflowId = await startWorkflow(workflow.name, opts.startInput ?? {});
  return { mode: 'mirrored', workflow, workflowId };
}
