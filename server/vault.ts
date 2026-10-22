import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";

import type { NoteEdge, NoteNode, TypeInfo, VaultGraph } from "../shared/types.ts";
export type { NoteEdge, NoteNode, TypeInfo, VaultGraph };

const SKIP_DIRS = new Set(["node_modules", ".git"]);
const WIKILINK = /\[\[([^\]]+?)\]\]/g;

async function walk(root: string, dir = root, out: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(root, full, out);
    else if (e.isFile() && e.name.endsWith(".md")) out.push(full);
  }
  return out;
}

function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  if (!text.startsWith("---")) return { data: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { data: {}, body: text };
  const raw = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\s*\n/, "");
  let data: Record<string, unknown> = {};
  try {
    const parsed = YAML.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    // keep going with empty frontmatter; the note still appears as a node
  }
  return { data, body };
}

function firstH1(body: string): string | null {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

function firstParagraph(body: string): string {
  const lines = body.split("\n");
  let i = 0;
  // skip until after the H1
  const h1 = lines.findIndex((l) => /^#\s+/.test(l));
  if (h1 >= 0) i = h1 + 1;
  const para: string[] = [];
  for (; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) {
      if (para.length) break;
      continue;
    }
    if (/^(#|```|\||!\[|<)/.test(l)) {
      if (para.length) break;
      continue;
    }
    para.push(l.replace(/^>\s*(\[!\w+\]\s*)?/, ""));
  }
  const text = para.join(" ").replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1");
  return text.length > 320 ? text.slice(0, 317) + "…" : text;
}

function linkTargets(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    for (const m of value.matchAll(WIKILINK)) out.push(m[1]);
  } else if (Array.isArray(value)) {
    for (const v of value) linkTargets(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) linkTargets(v, out);
  }
  return out;
}

function normalizeTarget(raw: string): string {
  let t = raw;
  const pipe = t.indexOf("|");
  if (pipe >= 0) t = t.slice(0, pipe);
  const hash = t.indexOf("#");
  if (hash >= 0) t = t.slice(0, hash);
  t = t.trim();
  if (t.endsWith(".md")) t = t.slice(0, -3);
  return t;
}

function pickColor(data: Record<string, unknown>): string | null {
  const c = (data._color ?? data.color) as unknown;
  return typeof c === "string" ? c : null;
}

const HUB_TYPES = new Set(["Project", "Responsibility", "Topic"]);

/**
 * Roll every note up to its nearest hub. Parent links are `belongs_to` (note -> parent) and the
 * inverse of `has` (parent has note). A Project found at the shortest distance wins; when the
 * upward walk reaches only Responsibilities or Topics, the nearest of those is the home "area".
 */
function assignHomes(notes: Map<string, NoteNode>, edges: NoteEdge[]): void {
  const parents = new Map<string, Set<string>>();
  const link = (child: string, parent: string) => {
    if (child === parent) return;
    (parents.get(child) ?? parents.set(child, new Set()).get(child)!).add(parent);
  };
  for (const e of edges) {
    if (e.kind === "belongs_to") link(e.source, e.target);
    else if (e.kind === "has") link(e.target, e.source);
  }
  for (const note of notes.values()) {
    if (note.type === "Type") continue;
    const seen = new Set<string>([note.id]);
    let frontier = [note.id];
    let depth = 0;
    let area: { ids: string[]; depth: number } | null = null;
    while (frontier.length && depth < 8) {
      depth++;
      const next: string[] = [];
      for (const n of frontier) {
        for (const p of parents.get(n) ?? []) {
          if (!seen.has(p)) {
            seen.add(p);
            next.push(p);
          }
        }
      }
      const projects = next.filter((id) => notes.get(id)?.type === "Project");
      if (projects.length) {
        note.home = projects[0];
        note.homeKind = "project";
        note.homeDepth = depth;
        note.homeAlternatives = projects.slice(1);
        break;
      }
      if (!area) {
        const areas = next.filter((id) => HUB_TYPES.has(notes.get(id)?.type ?? ""));
        if (areas.length) area = { ids: areas, depth };
      }
      frontier = next;
    }
    if (!note.home && area) {
      note.home = area.ids[0];
      note.homeKind = "area";
      note.homeDepth = area.depth;
      note.homeAlternatives = area.ids.slice(1);
    }
  }
}

export function slugify(label: string): string {
  return label.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export async function buildGraph(vaultPath: string, label?: string, slug?: string): Promise<VaultGraph> {
  const root = path.resolve(vaultPath);
  const files = await walk(root);
  const notes = new Map<string, NoteNode>();
  const byStem = new Map<string, string[]>();
  const rawLinks: { from: string; raw: string; kind: string }[] = [];
  const typeMeta = new Map<string, { color: string | null; icon: string | null; order: number | null }>();

  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    const id = rel.slice(0, -3);
    const stem = path.posix.basename(id);
    const folder = path.posix.dirname(id) === "." ? "" : path.posix.dirname(id);
    const [text, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
    const { data, body } = splitFrontmatter(text);
    const type = typeof data.type === "string" ? data.type : null;

    if (type === "Type") {
      const name = firstH1(body) ?? stem;
      const order = data._order ?? data.order;
      typeMeta.set(name, {
        color: pickColor(data),
        icon: (typeof data._icon === "string" ? data._icon : typeof data.icon === "string" ? data.icon : null),
        order: typeof order === "number" ? order : null,
      });
    }

    const properties: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      const targets = linkTargets(v);
      if (targets.length) {
        for (const raw of targets) rawLinks.push({ from: id, raw, kind: k });
      } else {
        properties[k] = v;
      }
    }
    for (const m of body.matchAll(WIKILINK)) rawLinks.push({ from: id, raw: m[1], kind: "body" });

    notes.set(id, {
      id,
      stem,
      title: firstH1(body) ?? stem,
      type,
      status: typeof data.status === "string" ? data.status : null,
      archived: data._archived === true || data.archived === true,
      organized: data._organized === true,
      folder,
      summary: firstParagraph(body),
      properties,
      outDegree: 0,
      inDegree: 0,
      modified: stat.mtime.toISOString(),
      home: null,
      homeKind: null,
      homeDepth: null,
      homeAlternatives: [],
    });
    const arr = byStem.get(stem) ?? [];
    arr.push(id);
    byStem.set(stem, arr);
  }

  const resolve = (raw: string): string | null => {
    const t = normalizeTarget(raw);
    if (!t) return null;
    if (notes.has(t)) return t;
    const candidates = byStem.get(path.posix.basename(t));
    if (candidates && candidates.length === 1) return candidates[0];
    return null;
  };

  const edgeSet = new Map<string, NoteEdge>();
  const unresolved: { from: string; raw: string }[] = [];
  for (const l of rawLinks) {
    const target = resolve(l.raw);
    if (!target) {
      unresolved.push({ from: l.from, raw: l.raw });
      continue;
    }
    if (target === l.from) continue;
    const key = `${l.from}\u0000${target}\u0000${l.kind}`;
    if (!edgeSet.has(key)) edgeSet.set(key, { source: l.from, target, kind: l.kind });
  }
  const edges = [...edgeSet.values()];
  for (const e of edges) {
    notes.get(e.source)!.outDegree++;
    notes.get(e.target)!.inDegree++;
  }

  assignHomes(notes, edges);

  const typeCounts = new Map<string, number>();
  for (const n of notes.values()) {
    const t = n.type ?? "(untyped)";
    typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
  }
  const types: TypeInfo[] = [...typeCounts.entries()]
    .map(([name, count]) => ({ name, count, ...(typeMeta.get(name) ?? { color: null, icon: null, order: null }) }))
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || b.count - a.count);

  const kindCounts = new Map<string, number>();
  for (const e of edges) kindCounts.set(e.kind, (kindCounts.get(e.kind) ?? 0) + 1);
  const edgeKinds = [...kindCounts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count);

  return {
    vault: {
      label: label ?? path.basename(root),
      path: root,
      slug: slug ?? slugify(label ?? path.basename(root)),
    },
    generatedAt: new Date().toISOString(),
    nodes: [...notes.values()],
    edges,
    types,
    edgeKinds,
    unresolved,
  };
}
