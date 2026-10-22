import Graph from "graphology";
import { circular } from "graphology-layout";
import type { VaultGraph } from "../types";
import { GHOST_COLOR, UNTYPED_COLOR, normalizeColor } from "./colors";
import { homeColor, isStructureKind, shapeFor, type HomeIndex, type HomeLevel, type HomeSettings } from "./home";

export interface NodeAttrs {
  label: string;
  type: string;
  color: string;
  typeColor: string;
  shape: string;
  home: string | null;
  /** 1 = edited recently … 0.15 = untouched for months; drives opacity when the recency toggle is on. */
  recency: number;
  size: number;
  degree: number;
  x: number;
  y: number;
  archived: boolean;
  status: string | null;
  folder: string;
  /** Target of a wikilink that resolves to no note (shown behind Filters → missing targets). */
  ghost?: boolean;
  [key: string]: unknown;
}
export interface EdgeAttrs {
  kind: string;
  /** Layout pull: hierarchy links group notes around their project, body links barely count. */
  weight: number;
  /** Visual emphasis relative to the default pull (1 = as drawn with default settings). */
  emphasis: number;
  [key: string]: unknown;
}

/** Body wikilinks are the noisiest lateral links and count for less than a declared relationship. */
const LATERAL_FACTOR: Record<string, number> = { body: 0.4 };
export const edgeWeight = (kind: string, ratio = 6, settings?: Pick<HomeSettings, "roles">) => (isStructureKind(kind, settings) ? ratio : LATERAL_FACTOR[kind] ?? 1);

/** Layout parameters the user can tune; see the Layout section of the sidebar. */
export interface LayoutSettings {
  /** Node size multiplier (display only). */
  nodeScale: number;
  /** ForceAtlas2 gravity: pull towards the centre. Lower = groups drift apart. */
  gravity: number;
  /** How many times harder a structure link (belongs_to, has, parent_*) pulls than a lateral one. 1–10. */
  ratio: number;
}
export const DEFAULT_LAYOUT: LayoutSettings = { nodeScale: 1, gravity: 1, ratio: 6 };

/** Visual weight of lateral links by ratio: 1 at ratio 1 (same as structure), 0.5 at the default 6, 0.1 at 10. */
export const lateralEmphasis = (ratio: number) => 0.1 + 0.9 * Math.max(0, Math.min(1, (10 - ratio) / 9));

export function applyEdgeWeights(graph: BrainGraph, ratioInput: number, settings?: Pick<HomeSettings, "roles">): void {
  const ratio = Number.isFinite(ratioInput) && ratioInput > 0 ? ratioInput : DEFAULT_LAYOUT.ratio;
  const lateral = lateralEmphasis(ratio);
  graph.updateEachEdgeAttributes((_e, a) => ({ ...a, weight: edgeWeight(a.kind, ratio, settings), emphasis: isStructureKind(a.kind, settings) ? 1 : lateral }), { attributes: ["weight", "emphasis"] });
}

/**
 * Recolour (and reshape) nodes in place; Sigma picks the attribute changes up without a rebuild.
 * Colour comes from the home grouping; when the vault has no group notes at all, the Type colours
 * from its Type notes are used instead so the graph is never uniformly grey.
 */
export function applyColors(graph: BrainGraph, level: HomeLevel, index: HomeIndex): void {
  const byId = index.byId;
  const noGroups = index.hubs.size === 0;
  graph.updateEachNodeAttributes((id, a) => {
    const note = byId.get(id);
    const shape = shapeFor(a.type, index.settings);
    if (noGroups || !note) return { ...a, color: a.typeColor, shape };
    return { ...a, color: homeColor(note, index, level), shape };
  }, { attributes: ["color", "shape"] });
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

/** The map always occupies this extent (graph units), centred on 0: the frame never has to change. */
export const MAP_EXTENT = 1000;

/** Robust bounding box of the positions (2nd to 98th percentile, so a few far-flung notes do not count). */
export function robustExtent(graph: BrainGraph): { x: [number, number]; y: [number, number]; span: number } | null {
  const xs: number[] = [];
  const ys: number[] = [];
  graph.forEachNode((_n, a) => {
    xs.push(a.x);
    ys.push(a.y);
  });
  if (xs.length < 2) return null;
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  const q = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))))];
  const x: [number, number] = [q(xs, 0.02), q(xs, 0.98)];
  const y: [number, number] = [q(ys, 0.02), q(ys, 0.98)];
  return { x, y, span: Math.max(x[1] - x[0], y[1] - y[0]) || 1 };
}

/**
 * Rescale all positions so the robust bounding box spans MAP_EXTENT and is centred on 0. Uniform
 * scale, no distortion. Done when a graph is built and when a layout run ends, never during a run:
 * ForceAtlas2 has a natural scale, and forcing another one every frame makes it collapse into a ball.
 */
export function normalizePositions(graph: BrainGraph): void {
  const e = robustExtent(graph);
  if (!e) return;
  const k = MAP_EXTENT / e.span;
  const cx = (e.x[0] + e.x[1]) / 2, cy = (e.y[0] + e.y[1]) / 2;
  if (Math.abs(k - 1) < 1e-6 && Math.abs(cx) < 1e-6 && Math.abs(cy) < 1e-6) return;
  graph.updateEachNodeAttributes((_n, a) => ({ ...a, x: (a.x - cx) * k, y: (a.y - cy) * k }), { attributes: ["x", "y"] });
}

/** Base node size from link count, times a user scale. */
export const nodeSize = (degree: number, scale = 1) => (2.5 + Math.min(14, Math.sqrt(degree) * 1.15)) * scale;

export function applyNodeScale(graph: BrainGraph, scale: number): void {
  graph.updateEachNodeAttributes((_n, a) => ({ ...a, size: nodeSize(a.degree, scale) }), { attributes: ["size"] });
}

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
  graph.setAttribute("vault", data.vault.slug);
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
      recency: 1,
      size: nodeSize(degree),
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
      graph.addEdgeWithKey(`${e.source}|${e.kind}|${e.target}`, e.source, e.target, { kind: e.kind, weight: edgeWeight(e.kind), emphasis: isStructureKind(e.kind) ? 1 : lateralEmphasis(DEFAULT_LAYOUT.ratio) });
    }
  }
  // Unresolved wikilink targets become small grey ghost nodes, one per distinct target, linked by a
  // "missing" edge from each note that points at them; `|alias` and `#anchor` suffixes are dropped.
  for (const u of data.unresolved) {
    const target = u.raw.split("|")[0].split("#")[0].trim().replace(/\.md$/, "");
    if (!target || !graph.hasNode(u.from)) continue;
    const id = `missing:${target}`;
    if (!graph.hasNode(id)) graph.addNode(id, { label: target, type: "(missing)", color: GHOST_COLOR, typeColor: GHOST_COLOR, shape: "circle", home: null, recency: 1, size: nodeSize(1), degree: 0, x: 0, y: 0, archived: false, status: null, folder: "", ghost: true });
    const key = `${u.from}|missing|${id}`;
    if (!graph.hasEdge(key)) {
      graph.addEdgeWithKey(key, u.from, id, { kind: "missing", weight: edgeWeight("missing"), emphasis: lateralEmphasis(DEFAULT_LAYOUT.ratio) });
      graph.updateNodeAttribute(id, "degree", (d) => (d as number) + 1);
    }
  }
  graph.forEachNode((id, a) => {
    if (a.ghost) graph.setNodeAttribute(id, "size", nodeSize(a.degree));
  });
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
  normalizePositions(graph);
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
