import type { NoteNode, VaultGraph } from "../types";

/** 0 = colour by root area, 1 = by top-level hub under it, 2 = by nearest hub. */
export type HomeLevel = 0 | 1 | 2;

export interface HomeSettings {
  /** Note types that act as grouping hubs. */
  hubTypes: Set<string>;
  /** Follow inverse `has` links (parent has note) when `belongs_to` alone reaches no hub. */
  useHas: boolean;
}

export const DEFAULT_HUB_TYPES = ["Project", "Responsibility", "Topic"];

/** Relationship keys that express "this note is part of that one": Tolaria's belongs_to plus parent_* keys (used by the archive). */
export const isParentKind = (kind: string) => kind === "belongs_to" || kind.startsWith("parent_");

/**
 * Default grouping for a vault: the Second Brain hub types when the vault has them, otherwise the
 * types most often found on the receiving end of a parent link (for the archive: Paper, Grant).
 */
export function defaultHubTypes(data: VaultGraph): string[] {
  const present = new Set(data.types.map((t) => t.name));
  const std = DEFAULT_HUB_TYPES.filter((t) => present.has(t));
  if (std.length) return std;
  const byId = new Map(data.nodes.map((n) => [n.id, n.type ?? "(untyped)"]));
  const counts = new Map<string, number>();
  for (const e of data.edges) {
    const target = isParentKind(e.kind) ? e.target : e.kind === "has" ? e.source : null;
    if (target) counts.set(byId.get(target)!, (counts.get(byId.get(target)!) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].filter(([t]) => t !== "(untyped)").sort((a, b) => b[1] - a[1]);
  const top = ranked.filter(([, c]) => c >= Math.max(3, (ranked[0]?.[1] ?? 0) * 0.15)).map(([t]) => t);
  return top.length ? top.slice(0, 3) : data.types.length ? [data.types[0].name] : [];
}

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

export interface NoteHome {
  hub: string | null;
  depth: number;
  alternatives: string[];
  viaHas: boolean;
}

export interface HomeIndex {
  settings: HomeSettings;
  hubs: Map<string, Hub>;
  roots: string[]; // sorted by subtree size, descending
  byId: Map<string, NoteNode>;
  homes: Map<string, NoteHome>;
  /** Hub colour per roll-up level (0 area, 1 project, 2 subproject). */
  palettes: Map<string, string>[];
}

/** Hue wheel for anchors; deeper hubs reuse the hue with lightness steps. */
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

/**
 * Roll every note up to its nearest hub. Parent links are `belongs_to` (note -> parent); the
 * inverse of `has` is used only as a fallback when `belongs_to` reaches no hub at all, because
 * this vault uses `has` for selective entry points, which would otherwise pull notes into the
 * wrong project. When Project is a hub type, the first Project met wins; otherwise the nearest
 * hub of any selected type.
 */
function computeHomes(data: VaultGraph, settings: HomeSettings): Map<string, NoteHome> {
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const strong = new Map<string, string[]>();
  const weak = new Map<string, string[]>();
  const link = (map: Map<string, string[]>, child: string, parent: string) => {
    if (child !== parent) (map.get(child) ?? map.set(child, []).get(child)!).push(parent);
  };
  for (const e of data.edges) {
    if (isParentKind(e.kind)) link(strong, e.source, e.target);
    else if (e.kind === "has") link(weak, e.target, e.source);
  }
  const isHub = (id: string) => settings.hubTypes.has(byId.get(id)?.type ?? "");
  const preferProject = settings.hubTypes.has("Project");

  const walk = (start: string, parents: Map<string, string[]>): NoteHome | null => {
    const seen = new Set([start]);
    let frontier = [start];
    let fallback: NoteHome | null = null;
    for (let depth = 1; depth <= 8 && frontier.length; depth++) {
      const next: string[] = [];
      for (const n of frontier) for (const p of parents.get(n) ?? []) if (!seen.has(p)) { seen.add(p); next.push(p); }
      const hubs = next.filter(isHub);
      const projects = preferProject ? hubs.filter((id) => byId.get(id)?.type === "Project") : hubs;
      if (projects.length) return { hub: projects[0], depth, alternatives: projects.slice(1), viaHas: parents === weak };
      if (hubs.length && !fallback) fallback = { hub: hubs[0], depth, alternatives: hubs.slice(1), viaHas: parents === weak };
      frontier = next;
    }
    return fallback;
  };

  const homes = new Map<string, NoteHome>();
  const both = new Map<string, string[]>();
  if (settings.useHas) for (const [k, v] of strong) both.set(k, v.slice());
  if (settings.useHas) for (const [k, v] of weak) both.set(k, [...(both.get(k) ?? []), ...v]);
  for (const n of data.nodes) {
    if (n.type === "Type") continue;
    const h = walk(n.id, strong) ?? (settings.useHas ? walk(n.id, both) : null);
    homes.set(n.id, h ?? { hub: null, depth: 0, alternatives: [], viaHas: false });
  }
  return homes;
}

export function buildHomeIndex(data: VaultGraph, settings: HomeSettings): HomeIndex {
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const homes = computeHomes(data, settings);
  const hubs = new Map<string, Hub>();
  for (const n of data.nodes) {
    if (!settings.hubTypes.has(n.type ?? "")) continue;
    hubs.set(n.id, { id: n.id, title: n.title, type: n.type!, parent: null, children: [], subtreeCount: 0, directCount: 0, depth: 0, color: UNHOMED });
  }
  for (const h of hubs.values()) {
    const p = homes.get(h.id)?.hub;
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

  const index: HomeIndex = { settings, hubs, roots: [], byId, homes, palettes: [] };
  for (const n of data.nodes) {
    if (n.type === "Type") continue;
    const chain = homeChain(n, index);
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
  index.roots = roots.map((r) => r.id);
  index.palettes = [0, 1, 2].map((level) => hubPalette(index, level as HomeLevel));
  for (const h of hubs.values()) h.color = index.palettes[1].get(h.id) ?? UNHOMED;
  return index;
}

/**
 * Colours for one roll-up level. Hubs at that depth (or shallower, when a branch is short) are the
 * "anchors" and get distinct hues in order of size; deeper hubs reuse their anchor's hue with a
 * lightness shift, so a subproject reads as a shade of its project.
 */
function hubPalette(index: HomeIndex, level: HomeLevel): Map<string, string> {
  const anchorIds = new Set<string>();
  for (const h of index.hubs.values()) anchorIds.add(anchorAt(index, h.id, level));
  const ordered = [...anchorIds].map((id) => index.hubs.get(id)!).sort((a, b) => b.subtreeCount - a.subtreeCount || a.title.localeCompare(b.title));
  const hueOf = new Map<string, { hue: number; sat: number }>();
  ordered.forEach((h, i) => hueOf.set(h.id, { hue: ROOT_HUES[i % ROOT_HUES.length], sat: i < ROOT_HUES.length ? 68 : 42 }));
  const out = new Map<string, string>();
  for (const h of index.hubs.values()) {
    const anchor = index.hubs.get(anchorAt(index, h.id, level))!;
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

/** Hub that a hub's cluster is labelled by at this roll-up level. */
export function anchorAt(index: HomeIndex, hubId: string, level: HomeLevel): string {
  let cur = index.hubs.get(hubId);
  while (cur && cur.depth > level && cur.parent) cur = index.hubs.get(cur.parent);
  return cur?.id ?? hubId;
}

/** Hubs from the note's nearest home up to the root (nearest first). For a hub itself, starts at the hub. */
export function homeChain(note: NoteNode, index: HomeIndex): string[] {
  const chain: string[] = [];
  let cur: string | null = index.hubs.has(note.id) ? note.id : (index.homes.get(note.id)?.hub ?? null);
  const seen = new Set<string>();
  while (cur && index.hubs.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    cur = index.hubs.get(cur)!.parent;
  }
  return chain;
}

export function homeColor(note: NoteNode, index: HomeIndex, level: HomeLevel): string {
  const chain = homeChain(note, index);
  if (!chain.length) return UNHOMED;
  return index.palettes[level].get(chain[0]) ?? UNHOMED;
}

/** Ids of all notes (and hubs) whose chain passes through `root`, plus the root itself. */
export function subtreeMembers(root: string, data: VaultGraph, index: HomeIndex): Set<string> {
  const out = new Set<string>([root]);
  for (const n of data.nodes) if (homeChain(n, index).includes(root)) out.add(n.id);
  return out;
}

/** Node shapes for group types, in the order the types were selected; every other note is a circle. */
export const GROUP_SHAPES = ["diamond", "square", "triangle", "rectangle"] as const;
export const SHAPE_GLYPH: Record<string, string> = { diamond: "◆", square: "■", triangle: "▲", rectangle: "▬", circle: "●" };

export function shapeFor(type: string | null, settings: HomeSettings): string {
  if (!type) return "circle";
  const i = [...settings.hubTypes].indexOf(type);
  return i < 0 ? "circle" : GROUP_SHAPES[i % GROUP_SHAPES.length];
}
