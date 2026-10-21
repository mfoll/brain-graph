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

export type Positions = Record<string, [number, number]>;

export interface BuiltGraph {
  graph: BrainGraph;
  /** Nodes that had no saved position and were placed heuristically. */
  fresh: string[];
  /** True when saved positions were applied to at least half of the nodes. */
  restored: boolean;
}

export function collectPositions(graph: BrainGraph): Positions {
  const out: Positions = {};
  graph.forEachNode((n, a) => {
    out[n] = [Math.round(a.x * 100) / 100, Math.round(a.y * 100) / 100];
  });
  return out;
}

export function buildGraph(data: VaultGraph, saved?: Positions | null): BuiltGraph {
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
  // Seed positions deterministically so a first layout is reproducible between reloads.
  circular.assign(graph, { scale: 100 });
  // Nudge by degree so hubs start closer to the centre and FA2 converges faster.
  graph.forEachNode((node, a) => {
    const pull = 1 / (1 + Math.sqrt(a.degree) / 3);
    graph.setNodeAttribute(node, "x", a.x * pull);
    graph.setNodeAttribute(node, "y", a.y * pull);
  });

  const fresh: string[] = [];
  let applied = 0;
  if (saved) {
    let cx = 0, cy = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    graph.forEachNode((node) => {
      const pos = saved[node];
      if (pos) {
        graph.mergeNodeAttributes(node, { x: pos[0], y: pos[1] });
        applied++;
        cx += pos[0]; cy += pos[1];
        minX = Math.min(minX, pos[0]); maxX = Math.max(maxX, pos[0]);
        minY = Math.min(minY, pos[1]); maxY = Math.max(maxY, pos[1]);
      } else fresh.push(node);
    });
    if (applied > 0) {
      cx /= applied; cy /= applied;
      const radius = Math.max(maxX - minX, maxY - minY) / 2 || 100;
      // Place new notes at the centroid of their already-placed neighbours (with a small jitter),
      // or on a ring around the map when nothing connects them yet.
      const freshSet = new Set(fresh);
      fresh.forEach((node, i) => {
        let sx = 0, sy = 0, k = 0;
        graph.forEachNeighbor(node, (m, ma) => {
          if (!freshSet.has(m)) { sx += ma.x; sy += ma.y; k++; }
        });
        const jitter = radius * 0.02;
        if (k > 0) {
          graph.mergeNodeAttributes(node, {
            x: sx / k + (Math.random() - 0.5) * jitter,
            y: sy / k + (Math.random() - 0.5) * jitter,
          });
        } else {
          const angle = (i / Math.max(1, fresh.length)) * Math.PI * 2;
          graph.mergeNodeAttributes(node, { x: cx + Math.cos(angle) * radius * 1.05, y: cy + Math.sin(angle) * radius * 1.05 });
        }
      });
    }
  }
  const restored = applied >= graph.order / 2;
  return { graph, fresh: restored ? fresh : [], restored };
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
