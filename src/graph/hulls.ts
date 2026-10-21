import type Sigma from "sigma";
import type { VaultGraph } from "../types";
import type { BrainGraph } from "./build";
import { homeChain, type HomeIndex, type HomeLevel } from "./home";

export interface HullOptions {
  index: HomeIndex;
  level: HomeLevel;
  hidden: Set<string>;
  data: VaultGraph;
  /** Theme-aware colours for the label halo. */
  halo: string;
  dim: boolean; // true while a node is hovered / selected: fade the hulls
}

type Pt = { x: number; y: number };

/** Hub that a note's cluster is labelled by at this roll-up level. */
export function anchorAt(index: HomeIndex, hubId: string, level: HomeLevel): string {
  let cur = index.hubs.get(hubId);
  while (cur && cur.depth > level && cur.parent) cur = index.hubs.get(cur.parent);
  return cur?.id ?? hubId;
}

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
export function drawHulls(sigma: Sigma, graph: BrainGraph, canvas: HTMLCanvasElement, opts: HullOptions): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width, height } = sigma.getDimensions();
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // Group visible nodes by their anchor hub at this level.
  const groups = new Map<string, (Pt & { r: number })[]>();
  const sizeRatio = sigma.scaleSize(1);
  graph.forEachNode((id, a) => {
    if (opts.hidden.has(id)) return;
    const note = opts.index.byId.get(id);
    if (!note) return;
    const chain = homeChain(note, opts.index.hubs);
    if (!chain.length) return;
    const anchor = anchorAt(opts.index, chain[0], opts.level);
    const p = sigma.graphToViewport({ x: a.x, y: a.y });
    (groups.get(anchor) ?? groups.set(anchor, []).get(anchor)!).push({ ...p, r: a.size * sizeRatio });
  });

  const palette = opts.index.palettes[opts.level];
  const pad = 16;
  const off = (drawHulls as unknown as { _off?: HTMLCanvasElement })._off ?? document.createElement("canvas");
  (drawHulls as unknown as { _off?: HTMLCanvasElement })._off = off;
  off.width = canvas.width;
  off.height = canvas.height;
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
    octx.beginPath();
    for (const p of pts) {
      octx.moveTo(p.x + p.r + pad, p.y);
      octx.arc(p.x, p.y, p.r + pad, 0, Math.PI * 2);
    }
    octx.fill();
    if (pts.length >= 6) {
      const x = Math.min(width - 60, Math.max(60, median(pts.map((p) => p.x))));
      const y = Math.min(height - 16, Math.max(16, median(pts.map((p) => p.y))));
      labels.push({ x, y, text: opts.index.hubs.get(anchor)?.title ?? anchor, color, n: pts.length });
    }
  }

  ctx.globalAlpha = opts.dim ? 0.05 : 0.16;
  ctx.drawImage(off, 0, 0, width, height);
  ctx.globalAlpha = opts.dim ? 0.2 : 0.9;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  for (const l of labels.sort((a, b) => b.n - a.n)) {
    const size = Math.round(11 + Math.min(10, Math.log2(l.n) * 1.4));
    ctx.font = `700 ${size}px Inter, system-ui, sans-serif`;
    ctx.lineWidth = 5;
    ctx.strokeStyle = opts.halo;
    ctx.strokeText(l.text, l.x, l.y);
    ctx.fillStyle = l.color;
    ctx.fillText(l.text, l.x, l.y);
  }
  ctx.globalAlpha = 1;
}
