import type { NoteNode, VaultGraph } from "../types";

export const HUB_TYPES = new Set(["Project", "Responsibility", "Topic"]);

/** 0 = colour by root area, 1 = by top-level project under it, 2 = by nearest hub. */
export type HomeLevel = 0 | 1 | 2;

export interface Hub {
  id: string;
  title: string;
  type: string;
  parent: string | null;
  children: string[];
  /** Notes whose home chain passes through this hub (including nested hubs). */
  subtreeCount: number;
  /** Notes whose nearest home is exactly this hub. */
  directCount: number;
  depth: number; // 0 = root
  color: string;
}

export interface HomeIndex {
  hubs: Map<string, Hub>;
  roots: string[]; // sorted by subtree size, descending
  byId: Map<string, NoteNode>;
  /** Hub colour per roll-up level (0 area, 1 project, 2 subproject). */
  palettes: Map<string, string>[];
}

/**
 * Colours for one roll-up level. Hubs at that depth (or shallower, when a branch is short) are the
 * "anchors" and get distinct hues in order of size; deeper hubs reuse their anchor's hue with a
 * lightness shift, so a subproject reads as a shade of its project.
 */
function hubPalette(index: HomeIndex, level: HomeLevel): Map<string, string> {
  const anchorOf = (h: Hub): Hub => {
    let cur = h;
    while (cur.depth > level && cur.parent) cur = index.hubs.get(cur.parent)!;
    return cur;
  };
  const anchors = [...index.hubs.values()].filter((h) => h.depth <= level && (h.depth === level || h.children.length === 0 || h.depth < level));
  // Keep only hubs that are actually anchors of something: themselves at `level`, or shallower leaves/short branches.
  const anchorIds = new Set<string>();
  for (const h of index.hubs.values()) anchorIds.add(anchorOf(h).id);
  const ordered = anchors.filter((h) => anchorIds.has(h.id)).sort((a, b) => b.subtreeCount - a.subtreeCount || a.title.localeCompare(b.title));
  const hueOf = new Map<string, { hue: number; sat: number }>();
  ordered.forEach((h, i) => hueOf.set(h.id, { hue: ROOT_HUES[i % ROOT_HUES.length], sat: i < ROOT_HUES.length ? 68 : 42 }));
  const out = new Map<string, string>();
  for (const h of index.hubs.values()) {
    const anchor = anchorOf(h);
    const { hue, sat } = hueOf.get(anchor.id) ?? { hue: 0, sat: 0 };
    const below = h.depth - anchor.depth; // 0 at the anchor itself
    const siblings = h.parent ? index.hubs.get(h.parent)!.children : [];
    const idx = siblings.indexOf(h.id);
    const spread = below > 0 && siblings.length > 1 ? (idx / (siblings.length - 1)) * 2 - 1 : 0;
    const light = below === 0 ? 48 : Math.max(30, Math.min(74, 54 + spread * 16 + (below - 1) * 6));
    out.set(h.id, hsl(hue, sat, light));
  }
  return out;
}

/** Hue wheel for root areas; children reuse the hue with lightness steps. */
const ROOT_HUES = [210, 25, 150, 280, 50, 340, 180, 95, 245, 10, 120, 300, 200, 60, 330, 160];
const UNHOMED = "#8b8f98";

/** Sigma's WebGL colour parser wants hex, so build hex from HSL ourselves. */
function hsl(h: number, s: number, l: number): string {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

export function buildHomeIndex(data: VaultGraph): HomeIndex {
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const hubs = new Map<string, Hub>();
  for (const n of data.nodes) {
    if (!HUB_TYPES.has(n.type ?? "")) continue;
    hubs.set(n.id, { id: n.id, title: n.title, type: n.type!, parent: null, children: [], subtreeCount: 0, directCount: 0, depth: 0, color: UNHOMED });
  }
  // Parent of a hub = its own nearest home (a hub too), guarding against cycles.
  for (const h of hubs.values()) {
    const p = byId.get(h.id)?.home;
    if (p && hubs.has(p) && p !== h.id) h.parent = p;
  }
  for (const h of hubs.values()) {
    const seen = new Set<string>([h.id]);
    let p = h.parent;
    while (p) {
      if (seen.has(p)) {
        h.parent = null; // break cycles
        break;
      }
      seen.add(p);
      p = hubs.get(p)?.parent ?? null;
    }
  }
  for (const h of hubs.values()) if (h.parent) hubs.get(h.parent)!.children.push(h.id);

  // Counts: every note contributes to each hub on its chain.
  for (const n of data.nodes) {
    if (n.type === "Type") continue;
    const chain = homeChain(n, hubs);
    if (chain.length) hubs.get(chain[0])!.directCount++;
    for (const id of chain) hubs.get(id)!.subtreeCount++;
  }

  const roots = [...hubs.values()].filter((h) => !h.parent).sort((a, b) => b.subtreeCount - a.subtreeCount || a.title.localeCompare(b.title));
  const walkDepth = (id: string, depth: number) => {
    const h = hubs.get(id)!;
    h.depth = depth;
    h.children.sort((a, b) => hubs.get(b)!.subtreeCount - hubs.get(a)!.subtreeCount);
    h.children.forEach((c) => walkDepth(c, depth + 1));
  };
  roots.forEach((r) => walkDepth(r.id, 0));

  const index: HomeIndex = { hubs, roots: roots.map((r) => r.id), byId, palettes: [] };
  index.palettes = [0, 1, 2].map((level) => hubPalette(index, level as HomeLevel));
  for (const h of hubs.values()) h.color = index.palettes[1].get(h.id) ?? UNHOMED;
  return index;
}

/** Hubs from the note's nearest home up to the root (nearest first). For a hub itself, starts at the hub. */
export function homeChain(note: NoteNode, hubs: Map<string, Hub>): string[] {
  const chain: string[] = [];
  let cur: string | null = HUB_TYPES.has(note.type ?? "") && hubs.has(note.id) ? note.id : note.home;
  const seen = new Set<string>();
  while (cur && hubs.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    cur = hubs.get(cur)!.parent;
  }
  return chain;
}


export function homeColor(note: NoteNode, index: HomeIndex, level: HomeLevel): string {
  const chain = homeChain(note, index.hubs);
  if (!chain.length) return UNHOMED;
  return index.palettes[level].get(chain[0]) ?? UNHOMED;
}

/** Ids of all notes (and hubs) whose chain passes through `root`, plus the root itself. */
export function subtreeMembers(root: string, data: VaultGraph, index: HomeIndex): Set<string> {
  const out = new Set<string>([root]);
  for (const n of data.nodes) if (homeChain(n, index.hubs).includes(root)) out.add(n.id);
  return out;
}

export const TYPE_SHAPES: Record<string, string> = {
  Project: "diamond",
  Responsibility: "square",
  Topic: "square",
  Question: "triangle",
};
