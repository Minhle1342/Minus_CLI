import { parentPort } from 'node:worker_threads';

type GraphEntry = [string, Array<[string, number]>];

interface GraphRankRequest {
  nodes: string[];
  edges: GraphEntry[];
  personalization: Array<[string, number]>;
}

function reverseEdges(nodes: string[], edges: Map<string, Map<string, number>>): Map<string, Map<string, number>> {
  const reversed = new Map(nodes.map((node) => [node, new Map<string, number>()]));
  for (const [source, outgoing] of edges) {
    for (const [target, weight] of outgoing) {
      const reverseOutgoing = reversed.get(target)!;
      reverseOutgoing.set(source, (reverseOutgoing.get(source) || 0) + weight);
    }
  }
  return reversed;
}

function pageRank(
  nodes: string[],
  edges: Map<string, Map<string, number>>,
  personalization: Map<string, number>,
): Array<[string, number]> {
  const size = nodes.length;
  const teleport = new Map<string, number>();
  const personalizationTotal = [...personalization.values()].reduce((sum, value) => sum + value, 0);
  for (const node of nodes) {
    teleport.set(node, personalizationTotal > 0 ? (personalization.get(node) || 0) / personalizationTotal : 1 / size);
  }
  let rank = new Map(nodes.map((node) => [node, 1 / size]));
  const damping = 0.85;
  for (let iteration = 0; iteration < 30; iteration++) {
    const next = new Map(nodes.map((node) => [node, (1 - damping) * (teleport.get(node) || 0)]));
    let danglingMass = 0;
    for (const source of nodes) {
      const outgoing = edges.get(source) || new Map<string, number>();
      const totalWeight = [...outgoing.values()].reduce((sum, weight) => sum + weight, 0);
      if (totalWeight <= 0) {
        danglingMass += rank.get(source) || 0;
        continue;
      }
      for (const [target, weight] of outgoing) {
        next.set(target, (next.get(target) || 0) + damping * (rank.get(source) || 0) * weight / totalWeight);
      }
    }
    for (const node of nodes) {
      next.set(node, (next.get(node) || 0) + damping * danglingMass * (teleport.get(node) || 0));
    }
    rank = next;
  }
  return Array.from(rank.entries());
}

parentPort?.on('message', (request: GraphRankRequest) => {
  const edges = new Map(request.edges.map(([source, outgoing]) => [source, new Map(outgoing)]));
  const personalization = new Map(request.personalization);
  const dependency = pageRank(request.nodes, edges, personalization);
  const impact = pageRank(request.nodes, reverseEdges(request.nodes, edges), personalization);
  parentPort?.postMessage({ dependency, impact });
});
