import { Type } from '@google/genai';
import type { ToolDefinition } from './types.js';
import type { PlanManager } from '../agent/plan-manager.js';
import { buildConductorWorkflow } from '../conductor/conductor-workflow.js';
import { registerWorkflow, startWorkflow } from '../conductor/conductor-client.js';

/**
 * Gọn nhất: read-only mirror Plan DAG -> Conductor.
 * Không đổi PlanManager/AgentOrchestrator. Fail-open: mọi lỗi Conductor
 * trả về { error } chứ không bao giờ throw làm sập AgentLoop.
 */
export function createExportPlanToConductorTool(planManager: PlanManager): ToolDefinition {
  return {
    name: 'export_plan_to_conductor',
    description:
      'Mirror the current plan DAG to Conductor OSS for durable execution (retry/pause/resume/observability). Read-only: local plan stays source of truth. No-op (dry-run JSON) when MINUS_CONDUCTOR_URL is unset.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        workflowName: {
          type: Type.STRING,
          description: 'Conductor workflow name (default: minus_plan_dag).',
        },
        dryRun: {
          type: Type.BOOLEAN,
          description: 'When true, only return the workflow JSON without calling the server.',
        },
      },
    },
    async execute(args) {
      try {
        const graph = planManager.getTaskGraph();
        if (!graph.nodes.length) {
          return { error: 'No plan to export: task graph is empty.', errorCode: 'EMPTY_PLAN' };
        }
        const workflowName =
          typeof args.workflowName === 'string' && args.workflowName.trim()
            ? args.workflowName.trim().slice(0, 80)
            : 'minus_plan_dag';
        const workflow = buildConductorWorkflow(
          {
            nodes: graph.nodes.map((n) => ({
              id: n.id,
              title: n.title,
              acceptanceCriteria: n.acceptanceCriteria,
              dependsOn: n.dependsOn,
              parallelizable: n.parallelizable,
              priority: n.priority,
              risk: n.risk,
            })),
            edges: graph.edges,
            parallelBatches: graph.parallelBatches,
          },
          workflowName,
        );

        const serverUrl = process.env.MINUS_CONDUCTOR_URL?.trim();
        if (!serverUrl || args.dryRun === true) {
          return {
            message: serverUrl
              ? 'Dry-run: workflow built, server not touched.'
              : 'Conductor disabled (MINUS_CONDUCTOR_URL unset): returning workflow JSON only.',
            mode: serverUrl ? 'dry-run' : 'disabled',
            workflow,
          };
        }

        await registerWorkflow(workflow);
        const workflowId = await startWorkflow(workflow.name, {
          exportedAt: new Date().toISOString(),
          taskCount: graph.nodes.length,
        });
        return { message: 'Plan mirrored to Conductor.', mode: 'mirrored', workflowId, workflow };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          errorCode: 'CONDUCTOR_EXPORT_FAILED',
          retryable: true,
        };
      }
    },
  };
}
