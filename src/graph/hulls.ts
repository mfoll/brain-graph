import type Sigma from "sigma";
import type { VaultGraph } from "../types";
import { isHierarchyKind, type BrainGraph } from "./build";
import { anchorAt, homeChain, type HomeIndex, type HomeLevel } from "./home";

export interface HullOptions {
  index: HomeIndex;
  level: HomeLevel;
  hidden: Set<string>;
  data: VaultGraph;
  /** Theme-aware colours for the label halo. */
  halo: string;
  dim: boolean; // true while a node is hovered / selected: fade the hulls
  quiet?: boolean; // note labels are shown: draw group names smaller and lighter
  /** Hub whose name must always be drawn (the focused group), even with few notes or when crowded. */
  emphasis?: string | null;
  /** Region size multiplier (1 = default). */
  regionSize?: number;
  /** Draw the tinted regions. */
  regions: boolean;
  /** Draw the group names. */
  names: boolean;
}

type Pt = { x: number; y: number };

function median(values: number[]): number {
  const v = values.slice().sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * Draws a tinted region per home group behind the graph, as the union of a soft disc around each
 * member node (so a region follows where its notes actually sit instead of a convex hull that
 * swallows everything between them), plus the group's name at its median position. Regions are
 * drawn opaque on an offscreen canvas and composited once with a low alpha, so overlaps never
 * stack up darker.
 */
function fit(canvas: HTMLCanvasElement, width: number, height: number, dpr: number): CanvasRenderingContext2D | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

export function clearHulls(back: HTMLCanvasElement, front: HTMLCanvasElement): void {
  for (const c of [back, front]) c.getContext("2d")?.clearRect(0, 0, c.width, c.height);
}

/** `back` sits behind the WebGL stage (tinted regions); `front` sits above it (group names). */
export function drawHulls(sigma: Sigma, graph: BrainGraph, back: HTMLCanvasElement, front: HTMLCanvasElement, opts: HullOptions): void {
  const { width, height } = sigma.getDimensions();
  const dpr = window.devicePixelRatio || 1;
  const ctx = fit(back, width, height, dpr);
  const fctx = fit(front, width, height, dpr);
  if (!ctx || !fctx) return;

  // Group visible nodes by their anchor hub at this level.
  const groups = new Map<string, (Pt & { r: number })[]>();
  const anchorOf = new Map<string, string>();
  const sizeRatio = sigma.scaleSize(1);
  // Padding is defined in graph units so regions scale with the map instead of with node pixels.
  const o = sigma.graphToViewport({ x: 0, y: 0 });
  const u = sigma.graphToViewport({ x: 1, y: 0 });
  const pxPerUnit = Math.hypot(u.x - o.x, u.y - o.y);
  const padUnits = 18 * (opts.regionSize ?? 1);
  const pad = Math.max(6, padUnits * pxPerUnit);
  graph.forEachNode((id, a) => {
    if (opts.hidden.has(id)) return;
    const note = opts.index.byId.get(id);
    if (!note) return;
    const chain = homeChain(note, opts.index);
    if (!chain.length) return;
    const anchor = anchorAt(opts.index, chain[0], opts.level);
    anchorOf.set(id, anchor);
    const p = sigma.graphToViewport({ x: a.x, y: a.y });
    (groups.get(anchor) ?? groups.set(anchor, []).get(anchor)!).push({ ...p, r: a.size * sizeRatio });
  });
  // Hierarchy links inside a group become thick rounded strokes, so a cluster reads as one shape
  // instead of a string of beads when its notes are small or a little apart.
  const strokes = new Map<string, [Pt, Pt][]>();
  graph.forEachEdge((_e, a, src, tgt) => {
    if (!isHierarchyKind(a.kind)) return;
    const g1 = anchorOf.get(src);
    if (!g1 || g1 !== anchorOf.get(tgt)) return;
    const p1 = sigma.graphToViewport(graph.getNodeAttributes(src));
    const p2 = sigma.graphToViewport(graph.getNodeAttributes(tgt));
    (strokes.get(g1) ?? strokes.set(g1, []).get(g1)!).push([p1, p2]);
  });

  const palette = opts.index.palettes[opts.level];
  const off = (drawHulls as unknown as { _off?: HTMLCanvasElement })._off ?? document.createElement("canvas");
  (drawHulls as unknown as { _off?: HTMLCanvasElement })._off = off;
  off.width = back.width;
  off.height = back.height;
  const octx = off.getContext("2d")!;
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, width, height);

  const labels: { x: number; y: number; text: string; color: string; n: number }[] = [];
  // Largest groups first so small groups stay visible on top of big ones.
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [anchor, pts] of ordered) {
    if (pts.length < 2) continue;
    const color = palette.get(anchor) ?? "#888";
    octx.fillStyle = color;
    octx.strokeStyle = color;
    octx.lineCap = "round";
    octx.lineJoin = "round";
    octx.lineWidth = pad * 1.6;
    octx.beginPath();
    for (const [p1, p2] of strokes.get(anchor) ?? []) {
      octx.moveTo(p1.x, p1.y);
      octx.lineTo(p2.x, p2.y);
    }
    octx.stroke();
    octx.beginPath();
    for (const p of pts) {
      octx.moveTo(p.x + p.r + pad, p.y);
      octx.arc(p.x, p.y, p.r + pad, 0, Math.PI * 2);
    }
    octx.fill();
    if (pts.length >= 4 || anchor === opts.emphasis) {
      const x = median(pts.map((p) => p.x));
      const y = Math.min(height - 16, Math.max(16, median(pts.map((p) => p.y))));
      labels.push({ x, y, text: opts.index.hubs.get(anchor)?.title ?? anchor, color, n: anchor === opts.emphasis ? Infinity : pts.length });
    }
  }

  if (opts.regions) {
    ctx.globalAlpha = opts.dim ? 0.05 : 0.16;
    ctx.drawImage(off, 0, 0, width, height);
    ctx.globalAlpha = 1;
  }
  if (!opts.names) return;

  // Names go on the front canvas so they stay readable over nodes and edges.
  fctx.globalAlpha = opts.dim ? 0.15 : opts.quiet ? 0.45 : 0.95;
  fctx.textAlign = "center";
  fctx.textBaseline = "middle";
  fctx.lineJoin = "round";
  // Largest groups are placed first. A name that would overlap an already placed one is nudged up or
  // down (a few steps) before being given up; the emphasised group is never given up.
  const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const overlaps = (b: { x0: number; y0: number; x1: number; y1: number }) => placed.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
  for (const l of labels.sort((a, b) => b.n - a.n)) {
    const n = Number.isFinite(l.n) ? l.n : 64;
    const size = Math.round((opts.quiet ? 10 : 12) + Math.min(opts.quiet ? 8 : 12, Math.log2(n) * (opts.quiet ? 1.1 : 1.6)));
    fctx.font = `700 ${size}px Inter, system-ui, sans-serif`;
    const w = fctx.measureText(l.text).width + 12;
    l.x = Math.min(width - w / 2 - 4, Math.max(w / 2 + 4, l.x));
    const h = size * 0.75;
    const step = size * 1.6;
    let box = { x0: l.x - w / 2, y0: l.y - h, x1: l.x + w / 2, y1: l.y + h };
    let ok = !overlaps(box);
    for (let k = 1; !ok && k <= 3; k++) {
      for (const dy of [k * step, -k * step]) {
        const y = Math.min(height - h, Math.max(h, l.y + dy));
        const cand = { x0: l.x - w / 2, y0: y - h, x1: l.x + w / 2, y1: y + h };
        if (!overlaps(cand)) {
          box = cand;
          l.y = y;
          ok = true;
          break;
        }
      }
    }
    if (!ok && !Number.isFinite(l.n)) ok = true; // emphasised: draw anyway
    if (!ok) continue;
    placed.push(box);
    fctx.lineWidth = Math.max(4, size / 3);
    fctx.strokeStyle = opts.halo;
    fctx.strokeText(l.text, l.x, l.y);
    fctx.fillStyle = l.color;
    fctx.fillText(l.text, l.x, l.y);
  }
  fctx.globalAlpha = 1;
}
