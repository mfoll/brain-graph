import type { NoteNode, VaultGraph } from "../types";

/** 0 = colour by root area, 1 = by top-level hub under it, 2 = by nearest hub. */
export type HomeLevel = 0 | 1 | 2;

/** What a relationship kind means for the hierarchy. */
export type LinkRole = "up" | "down" | "lateral"; // up: child -> parent (belongs_to); down: parent -> child (has)

export interface HomeSettings {
  /** Note types that act as grouping hubs. */
  hubTypes: Set<string>;
  /** Follow parent -> child kinds (e.g. `has`) when the child -> parent kinds alone reach no hub. */
  useHas: boolean;
  /** Colour palette for groups (see PALETTES). */
  palette?: PaletteId;
  /** Role of each relationship kind; kinds not listed take the convention default (see defaultLinkRole). */
  roles?: Record<string, LinkRole>;
}

/** Tolaria's conventions: belongs_to and parent_* point to the parent, has points to children, the rest is lateral. */
export function defaultLinkRole(kind: string): LinkRole {
  if (kind === "belongs_to" || kind.startsWith("parent_")) return "up";
  if (kind === "has") return "down";
  return "lateral";
}
export const linkRole = (kind: string, settings?: Pick<HomeSettings, "roles">): LinkRole => settings?.roles?.[kind] ?? defaultLinkRole(kind);
/** Any role but lateral: the link says where a note belongs. */
export const isStructureKind = (kind: string, settings?: Pick<HomeSettings, "roles">) => linkRole(kind, settings) !== "lateral";

/** Categorical palettes for the groups, biggest group first. Sub-groups take shades of their parent's hue. */
export const PALETTES = {
  vivid: { label: "Vivid", colors: ["#3b82f6", "#f97316", "#10b981", "#a855f7", "#eab308", "#ec4899", "#06b6d4", "#84cc16", "#6366f1", "#ef4444", "#22c55e", "#d946ef", "#0ea5e9", "#f59e0b", "#f43f5e", "#14b8a6"] },
  tableau: { label: "Tableau 10", colors: ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac"] },
  okabe: { label: "Okabe–Ito (colour-blind safe)", colors: ["#0072b2", "#e69f00", "#009e73", "#cc79a7", "#d55e00", "#56b4e9", "#f0e442", "#999999"] },
  pastel: { label: "Pastel", colors: ["#8da0cb", "#fc8d62", "#66c2a5", "#e78ac3", "#a6d854", "#ffd92f", "#e5c494", "#b3b3b3", "#80b1d3", "#fb8072", "#bebada", "#fdb462"] },
  earth: { label: "Earth", colors: ["#8c510a", "#35978f", "#bf812d", "#01665e", "#dfc27d", "#80cdc1", "#543005", "#003c30", "#c7eae5", "#f6e8c3", "#7f3b08", "#2d004b"] },
  nord: { label: "Nord", colors: ["#5e81ac", "#d08770", "#a3be8c", "#b48ead", "#ebcb8b", "#bf616a", "#88c0d0", "#81a1c1", "#8fbcbb", "#d8dee9"] },
} as const;
export type PaletteId = keyof typeof PALETTES;
export const DEFAULT_PALETTE: PaletteId = "vivid";

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16) / 255, g = parseInt(m.slice(2, 4), 16) / 255, b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s: s * 100, l: l * 100 };
}

export const DEFAULT_HUB_TYPES = ["Project", "Responsibility", "Topic"];

/**
 * Default grouping for a vault: the Second Brain hub types when the vault has them, otherwise the
 * types most often found on the receiving end of a parent link (for the archive: Paper, Grant).
 */
export function defaultHubTypes(data: VaultGraph, settings?: Pick<HomeSettings, "roles">): string[] {
  const present = new Set(data.types.map((t) => t.name));
  const std = DEFAULT_HUB_TYPES.filter((t) => present.has(t));
  if (std.length) return std;
  const byId = new Map(data.nodes.map((n) => [n.id, n.type ?? "(untyped)"]));
  const counts = new Map<string, number>();
  for (const e of data.edges) {
    const role = linkRole(e.kind, settings);
    const target = role === "up" ? e.target : role === "down" ? e.source : null;
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
  /** Steps from the note to its hub, nearest first: which relationship led to which note. */
  path: { via: string; id: string }[];
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
 * vaults commonly use `has` for selective entry points rather than ownership, which would otherwise
 * pull notes into the wrong group. When Project is a hub type, the first Project met wins; otherwise the nearest
 * hub of any selected type.
 */
function computeHomes(data: VaultGraph, settings: HomeSettings): Map<string, NoteHome> {
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  type Parent = { id: string; via: string };
  const strong = new Map<string, Parent[]>();
  const both = new Map<string, Parent[]>();
  const link = (map: Map<string, Parent[]>, child: string, parent: string, via: string) => {
    if (child !== parent) (map.get(child) ?? map.set(child, []).get(child)!).push({ id: parent, via });
  };
  for (const e of data.edges) {
    const role = linkRole(e.kind, settings);
    if (role === "up") {
      link(strong, e.source, e.target, e.kind);
      link(both, e.source, e.target, e.kind);
    } else if (role === "down") link(both, e.target, e.source, e.kind);
  }
  const isHub = (id: string) => settings.hubTypes.has(byId.get(id)?.type ?? "");
  const preferProject = settings.hubTypes.has("Project");

  type Step = { id: string; path: Parent[] };
  const walk = (start: string, parents: Map<string, Parent[]>): NoteHome | null => {
    const seen = new Set([start]);
    let frontier: Step[] = [{ id: start, path: [] }];
    let fallback: NoteHome | null = null;
    const toHome = (picked: Step[], depth: number): NoteHome => ({
      hub: picked[0].id,
      depth,
      alternatives: picked.slice(1).map((s) => s.id),
      viaHas: picked[0].path.some((p) => linkRole(p.via, settings) === "down"),
      path: picked[0].path,
    });
    for (let depth = 1; depth <= 8 && frontier.length; depth++) {
      const next: Step[] = [];
      for (const f of frontier) for (const p of parents.get(f.id) ?? []) if (!seen.has(p.id)) { seen.add(p.id); next.push({ id: p.id, path: [...f.path, p] }); }
      const hubs = next.filter((s) => isHub(s.id));
      const projects = preferProject ? hubs.filter((s) => byId.get(s.id)?.type === "Project") : hubs;
      if (projects.length) return toHome(projects, depth);
      if (hubs.length && !fallback) fallback = toHome(hubs, depth);
      frontier = next;
    }
    return fallback;
  };

  const homes = new Map<string, NoteHome>();
  for (const n of data.nodes) {
    if (n.type === "Type") continue;
    const h = walk(n.id, strong) ?? (settings.useHas ? walk(n.id, both) : null);
    homes.set(n.id, h ?? { hub: null, depth: 0, alternatives: [], viaHas: false, path: [] });
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
  const colors = PALETTES[index.settings.palette ?? DEFAULT_PALETTE].colors;
  const baseOf = new Map<string, { h: number; s: number; l: number }>();
  ordered.forEach((hub, i) => {
    const c = hexToHsl(colors[i % colors.length]);
    // Beyond the palette's length, desaturate so repeated hues stay distinguishable.
    baseOf.set(hub.id, i < colors.length ? c : { ...c, s: c.s * 0.55 });
  });
  const out = new Map<string, string>();
  for (const h of index.hubs.values()) {
    const anchor = index.hubs.get(anchorAt(index, h.id, level))!;
    const base = baseOf.get(anchor.id) ?? { h: 0, s: 0, l: 50 };
    const below = h.depth - anchor.depth; // 0 at the anchor itself
    const siblings = h.parent ? index.hubs.get(h.parent)!.children : [];
    const idx = siblings.indexOf(h.id);
    const spread = below > 0 && siblings.length > 1 ? (idx / (siblings.length - 1)) * 2 - 1 : 0;
    const light = below === 0 ? base.l : Math.max(28, Math.min(78, base.l + spread * 14 + (below - 1) * 6));
    out.set(h.id, hsl(base.h, base.s, light));
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
