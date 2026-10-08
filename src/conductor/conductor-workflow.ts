/**
 * Conductor workflow builder (sidecar, additive-only).
 * Converts PlanTaskGraph -> Conductor workflow JSON without touching
 * PlanManager / AgentOrchestrator (both CRITICAL risk).
 * Uses only structural typing: no runtime import from src/agent/*.
 */
export interface ConductorPlanNode {
  id: number;
  title: string;
  acceptanceCriteria: string;
  dependsOn: number[];
  parallelizable: boolean;
  priority: number;
  risk: string;
}

export interface ConductorPlanGraph {
  nodes: ConductorPlanNode[];
  edges: Array<{ from: number; to: number }>;
  parallelBatches: number[][];
}

export interface ConductorTaskDef {
  name: string;
  taskReferenceName: string;
  type: 'SIMPLE';
  inputParameters: Record<string, unknown>;
}

export interface ConductorWorkflowDef {
  name: string;
  description: string;
  version: number;
  tasks: ConductorTaskDef[];
  outputParameters: Record<string, unknown>;
}

function refName(id: number): string {
  return `plan_task_${id}`;
}

export function buildConductorWorkflow(
  graph: ConductorPlanGraph,
  workflowName = 'minus_plan_dag',
): ConductorWorkflowDef {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const tasks: ConductorTaskDef[] = [];

  // Preserve topological order: parallelBatches first, then leftovers.
  const seen = new Set<number>();
  const ordered: number[] = [];
  for (const batch of graph.parallelBatches) {
    const sorted = [...batch].sort(
      (a, b) => (byId.get(b)?.priority ?? 0) - (byId.get(a)?.priority ?? 0),
    );
    for (const id of sorted) {
      if (byId.has(id) && !seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
  }
  for (const n of graph.nodes) {
    if (!seen.has(n.id)) {
      seen.add(n.id);
      ordered.push(n.id);
    }
  }

  for (const id of ordered) {
    const node = byId.get(id);
    if (!node) continue;
    // Conductor SIMPLE tasks are durable + retryable server-side.
    // Dependencies are encoded explicitly so the server, not the
    // in-memory scheduler, owns ordering/retry/pause/resume.
    tasks.push({
      name: 'minus_plan_task',
      taskReferenceName: refName(id),
      type: 'SIMPLE',
      inputParameters: {
        taskId: node.id,
        title: node.title,
        acceptanceCriteria: node.acceptanceCriteria,
        dependsOn: node.dependsOn.map(refName),
        dependsOnIds: node.dependsOn,
        risk: node.risk,
        parallelizable: node.parallelizable,
      },
    });
  }

  return {
    name: workflowName,
    description: 'MinusCLI plan DAG mirrored to Conductor for durable execution (shadow mode).',
    version: 1,
    tasks,
    outputParameters: {
      // Conductor expression: last task output mirrors plan result.
      result: `\${${refName(ordered[ordered.length - 1] ?? 0)}.output}`,
    },
  };
}
