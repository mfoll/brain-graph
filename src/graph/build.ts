import Graph from "graphology";
import { circular } from "graphology-layout";
import type { NoteNode, VaultGraph } from "../types";
import { GHOST_COLOR, UNTYPED_COLOR, normalizeColor } from "./colors";
import { anchorAt, homeChain, homeColor, isStructureKind, shapeFor, type HomeIndex, type HomeLevel, type HomeSettings } from "./home";

export interface NodeAttrs {
  label: string;
  type: string;
  color: string;
  typeColor: string;
  shape: string;
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
  /** A note of another vault this vault links to (Filters → notes from other vaults); `via` is the first linking note. */
  bridge?: { vault: string; vaultLabel: string; path: string; via: string; type: string | null; summary: string };
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
export const DEFAULT_LAYOUT: LayoutSettings = { nodeScale: 0.9, gravity: 0.3, ratio: 8 };

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
/**
 * The colour a group is drawn in at a colour level: that of the group it rolls up to at that level, so
 * every note, region and name inside one coloured group shares one colour. At "nearest group" each
 * group keeps its own colour, a shade of its parent's hue.
 */
export function groupColor(index: HomeIndex, hubId: string, level: HomeLevel): string {
  return index.palettes[level].get(level === 2 ? hubId : anchorAt(index, hubId, level)) ?? "#8b8f98";
}

/** A note's map colour: its group's colour at this level; homeColor decides for notes with no group. */
function noteColor(note: NoteNode, index: HomeIndex, level: HomeLevel): string {
  const chain = homeChain(note, index);
  return chain.length ? groupColor(index, chain[0], level) : homeColor(note, index, level);
}

export function applyColors(graph: BrainGraph, level: HomeLevel, index: HomeIndex): void {
  const byId = index.byId;
  const noGroups = index.hubs.size === 0;
  graph.updateEachNodeAttributes((id, a) => {
    const note = byId.get(id);
    const shape = shapeFor(a.type, index.settings);
    if (a.bridge) {
      // A bridge takes the colour of the note that points at it and keeps its rectangle.
      const via = byId.get(a.bridge.via);
      return { ...a, color: via && !noGroups ? noteColor(via, index, level) : a.typeColor, shape: "rectangle" };
    }
    if (noGroups || !note) return { ...a, color: a.typeColor, shape };
    return { ...a, color: noteColor(note, index, level), shape };
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
    if (a.ghost || a.bridge) return;
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

/**
 * Where a note should sit: beside the placed neighbour it is most strongly linked to (summed layout
 * weight of all links between them, so a parent wins over lateral links). A centroid of neighbours was
 * tried first and dropped: a note linked into two clusters landed in the empty space between them.
 * Ghost and bridge neighbours do not count.
 */
function anchorPoint(graph: BrainGraph, node: string, placed: (n: string) => boolean): { x: number; y: number } | null {
  const weight = new Map<string, number>();
  graph.forEachEdge(node, (_e, ea, s, t) => {
    const m = s === node ? t : s;
    const ma = graph.getNodeAttributes(m);
    if (m !== node && placed(m) && !ma.ghost && !ma.bridge) weight.set(m, (weight.get(m) ?? 0) + ea.weight);
  });
  let best: string | null = null;
  for (const [m, w] of weight) if (!best || w > weight.get(best)!) best = m;
  return best ? { x: graph.getNodeAttribute(best, "x"), y: graph.getNodeAttribute(best, "y") } : null;
}

/** Notes whose nearest linked note is farther than `limit`: placed before they had links, or relinked since. */
function strandedNodes(graph: BrainGraph, limit: number): string[] {
  const out: string[] = [];
  graph.forEachNode((n, a) => {
    if (a.ghost || a.bridge) return;
    let nearest = Infinity;
    graph.forEachNeighbor(n, (_m, ma) => {
      if (!ma.ghost && !ma.bridge) nearest = Math.min(nearest, Math.hypot(ma.x - a.x, ma.y - a.y));
    });
    if (Number.isFinite(nearest) && nearest > limit) out.push(n);
  });
  return out;
}

/**
 * Move stranded notes next to their strongest neighbours (a short layout run then settles them).
 * Returns the moved ids. Used when a map is restored and before "Update layout", whose small step
 * cap could otherwise never bring a far outlier back.
 */
export function placeStranded(graph: BrainGraph, also: string[] = []): string[] {
  const ext = robustExtent(graph);
  if (!ext) return [];
  const span = ext.span || 100;
  const moved = new Set([...also, ...strandedNodes(graph, span * 0.15)]);
  const placed = (n: string) => !moved.has(n);
  for (const n of moved) {
    const p = anchorPoint(graph, n, placed);
    if (!p) continue;
    // A small random offset so siblings placed beside the same parent do not overlap.
    const angle = Math.random() * Math.PI * 2;
    const r = span * (0.01 + Math.random() * 0.015);
    graph.mergeNodeAttributes(n, { x: p.x + Math.cos(angle) * r, y: p.y + Math.sin(angle) * r });
  }
  return [...moved].filter((n) => anchorPoint(graph, n, () => true));
}

/**
 * Ghost (missing target) and bridge (note of another vault) nodes are decorations, not physics: they take no
 * part in layout runs and sit in a small sunflower around the note that points at them (a bridge's first
 * linking note, a ghost's first mentioning note). Left to the physics they drifted to the map's rim
 * while hidden, since their links are dropped when their toggle is off. Positions are in map units.
 */
export function placeSatellites(graph: BrainGraph): void {
  const byAnchor = new Map<string, string[]>();
  graph.forEachNode((n, a) => {
    if (!a.ghost && !a.bridge) return;
    const anchor = a.bridge?.via ?? graph.neighbors(n)[0];
    if (anchor && graph.hasNode(anchor)) (byAnchor.get(anchor) ?? byAnchor.set(anchor, []).get(anchor)!).push(n);
  });
  for (const [anchor, sats] of byAnchor) {
    const { x, y } = graph.getNodeAttributes(anchor);
    sats.sort().forEach((n, k) => {
      const r = 12 * Math.sqrt(k + 1);
      const t = k * 2.39996; // golden angle: an even fan however many records a note lists
      graph.mergeNodeAttributes(n, { x: x + r * Math.cos(t), y: y + r * Math.sin(t) });
    });
  }
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
    if (!graph.hasNode(id)) graph.addNode(id, { label: target, type: "(missing)", color: GHOST_COLOR, typeColor: GHOST_COLOR, shape: "circle", recency: 1, size: nodeSize(1), degree: 0, x: 0, y: 0, archived: false, status: null, folder: "", ghost: true });
    const key = `${u.from}|missing|${id}`;
    if (!graph.hasEdge(key)) {
      graph.addEdgeWithKey(key, u.from, id, { kind: "missing", weight: edgeWeight("missing"), emphasis: lateralEmphasis(DEFAULT_LAYOUT.ratio) });
      graph.updateNodeAttribute(id, "degree", (d) => (d as number) + 1);
    }
  }
  // Notes of other vaults: one rectangle per target, linked by a "cross-vault" edge from each linking note.
  for (const b of data.bridges ?? []) {
    if (!graph.hasNode(b.from)) continue;
    const id = `bridge:${b.vault}/${b.path}`;
    if (!graph.hasNode(id)) graph.addNode(id, { label: b.title, type: b.type ?? "note", color: GHOST_COLOR, typeColor: GHOST_COLOR, shape: "rectangle", recency: 1, size: nodeSize(1), degree: 0, x: 0, y: 0, archived: false, status: null, folder: "", bridge: { vault: b.vault, vaultLabel: b.vaultLabel, path: b.path, via: b.from, type: b.type, summary: b.summary } });
    const key = `${b.from}|cross-vault|${id}`;
    if (!graph.hasEdge(key)) {
      graph.addEdgeWithKey(key, b.from, id, { kind: "cross-vault", weight: edgeWeight("cross-vault"), emphasis: lateralEmphasis(DEFAULT_LAYOUT.ratio) });
      graph.updateNodeAttribute(id, "degree", (d) => (d as number) + 1);
    }
  }
  graph.forEachNode((id, a) => {
    if (a.ghost || a.bridge) graph.setNodeAttribute(id, "size", nodeSize(a.degree));
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
      } else if (!graph.getNodeAttribute(node, "ghost") && !graph.getNodeAttribute(node, "bridge")) fresh.push(node);
    });
    if (applied > 0) {
      cx /= applied; cy /= applied;
      const radius = Math.max(maxX - minX, maxY - minY) / 2 || 100;
      // Notes with no links yet wait on a ring around the map; once linked, placeStranded brings them in.
      fresh.forEach((node, i) => {
        const angle = (i / Math.max(1, fresh.length)) * Math.PI * 2;
        graph.mergeNodeAttributes(node, { x: cx + Math.cos(angle) * radius * 1.05, y: cy + Math.sin(angle) * radius * 1.05 });
      });
      // New notes go next to their strongest neighbours; notes stranded far from every neighbour
      // (placed before they had links) are brought back the same way, and both get the settling run.
      for (const n of placeStranded(graph, fresh)) if (!fresh.includes(n)) fresh.push(n);
    }
  }
  const restored = applied >= graph.order / 2;
  normalizePositions(graph);
  placeSatellites(graph);
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
