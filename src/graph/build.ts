import Graph from "graphology";
import { circular } from "graphology-layout";
import type { VaultGraph } from "../types";
import { UNTYPED_COLOR, normalizeColor } from "./colors";
import { TYPE_SHAPES, homeColor, type HomeIndex, type HomeLevel } from "./home";

export interface NodeAttrs {
  label: string;
  type: string;
  color: string;
  typeColor: string;
  shape: string;
  home: string | null;
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
  /** Layout pull: hierarchy links group notes around their project, body links barely count. */
  weight: number;
  [key: string]: unknown;
}

const EDGE_WEIGHTS: Record<string, number> = { belongs_to: 4, has: 4, surface_for: 2, source_note: 2, related_to: 1, body: 0.4 };
export const edgeWeight = (kind: string) => EDGE_WEIGHTS[kind] ?? 1.5;

export type ColorMode = "type" | "home";

/** Recolour (and reshape) nodes in place; Sigma picks the attribute changes up without a rebuild. */
export function applyColors(graph: BrainGraph, mode: ColorMode, level: HomeLevel, data: VaultGraph, index: HomeIndex): void {
  const byId = index.byId;
  graph.updateEachNodeAttributes((id, a) => {
    const note = byId.get(id);
    if (mode === "type" || !note) return { ...a, color: a.typeColor, shape: "circle" };
    return { ...a, color: homeColor(note, index, level), shape: TYPE_SHAPES[a.type] ?? "circle" };
  }, { attributes: ["color", "shape"] });
  void data;
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
    const typeColor = colors.get(type) ?? UNTYPED_COLOR;
    graph.addNode(n.id, {
      label: n.title,
      type,
      color: typeColor,
      typeColor,
      shape: "circle",
      home: n.home,
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
      graph.addEdgeWithKey(`${e.source}|${e.kind}|${e.target}`, e.source, e.target, { kind: e.kind, weight: edgeWeight(e.kind) });
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
