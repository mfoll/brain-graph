import Graph from "graphology";
import { circular } from "graphology-layout";
import type { VaultGraph } from "../types";
import { UNTYPED_COLOR, normalizeColor } from "./colors";

export interface NodeAttrs {
  label: string;
  type: string;
  color: string;
  size: number;
  degree: number;
  x: number;
  y: number;
  archived: boolean;
  status: string | null;
  folder: string;
  [key: string]: unknown;
}
export interface EdgeAttrs {
  kind: string;
  [key: string]: unknown;
}

export type BrainGraph = Graph<NodeAttrs, EdgeAttrs>;

export function typeColorMap(data: VaultGraph): Map<string, string> {
  const map = new Map<string, string>();
  data.types.forEach((t, i) => {
    map.set(t.name, t.name === "(untyped)" ? UNTYPED_COLOR : normalizeColor(t.color, i));
  });
  return map;
}

export function buildGraph(data: VaultGraph): BrainGraph {
  const colors = typeColorMap(data);
  const graph: BrainGraph = new Graph({ multi: true, type: "directed", allowSelfLoops: false });
  for (const n of data.nodes) {
    const degree = n.inDegree + n.outDegree;
    const type = n.type ?? "(untyped)";
    graph.addNode(n.id, {
      label: n.title,
      type,
      color: colors.get(type) ?? UNTYPED_COLOR,
      size: 2.5 + Math.min(14, Math.sqrt(degree) * 1.15),
      degree,
      x: 0,
      y: 0,
      archived: n.archived,
      status: n.status,
      folder: n.folder,
    });
  }
  for (const e of data.edges) {
    if (graph.hasNode(e.source) && graph.hasNode(e.target)) {
      graph.addEdgeWithKey(`${e.source}|${e.kind}|${e.target}`, e.source, e.target, { kind: e.kind });
    }
  }
  // Seed positions deterministically so the layout is reproducible between reloads.
  circular.assign(graph, { scale: 100 });
  // Nudge by degree so hubs start closer to the centre and FA2 converges faster.
  graph.forEachNode((node, a) => {
    const pull = 1 / (1 + Math.sqrt(a.degree) / 3);
    graph.setNodeAttribute(node, "x", a.x * pull);
    graph.setNodeAttribute(node, "y", a.y * pull);
  });
  return graph;
}

/** Nodes within `depth` hops of `root` (undirected), including root. */
export function neighborhood(graph: BrainGraph, root: string, depth: number): Set<string> {
  const seen = new Set<string>([root]);
  let frontier = [root];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: string[] = [];
    for (const n of frontier) {
      graph.forEachNeighbor(n, (m) => {
        if (!seen.has(m)) {
          seen.add(m);
          next.push(m);
        }
      });
    }
    frontier = next;
  }
  return seen;
}
