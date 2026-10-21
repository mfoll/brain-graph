// Audit dump of the home hierarchy the viewer infers from belongs_to (and inverse has).
// Usage: pnpm graph:homes [vault-path] [--no-has] [--hubs=Project,Responsibility,Topic] [--json]
import { buildGraph } from "./vault.ts";
import type { NoteEdge, NoteNode } from "../shared/types.ts";

const args = process.argv.slice(2);
const vault = args.find((a) => !a.startsWith("--")) ?? process.env.VAULT ?? ".";
const useHas = !args.includes("--no-has");
const hubTypes = new Set((args.find((a) => a.startsWith("--hubs="))?.slice(7) ?? "Project,Responsibility,Topic").split(","));
const asJson = args.includes("--json");

const g = await buildGraph(vault);
const byId = new Map(g.nodes.map((n) => [n.id, n]));
type Parent = { id: string; via: string };
const strong = new Map<string, Parent[]>();
const both = new Map<string, Parent[]>();
const link = (map: Map<string, Parent[]>, child: string, parent: string, via: string) => {
  if (child !== parent) (map.get(child) ?? map.set(child, []).get(child)!).push({ id: parent, via });
};
for (const e of g.edges as NoteEdge[]) {
  if (e.kind === "belongs_to") { link(strong, e.source, e.target, "belongs_to"); link(both, e.source, e.target, "belongs_to"); }
  else if (useHas && e.kind === "has") link(both, e.target, e.source, "has");
}
const isHub = (id: string) => hubTypes.has(byId.get(id)?.type ?? "");

interface Home { hub: string | null; depth: number; path: string[]; alternatives: string[] }
// Same rule as the viewer: belongs_to chains first; inverse `has` only when that finds no hub.
function home(note: NoteNode): Home {
  return walk(note, strong) ?? (useHas ? walk(note, both) : null) ?? { hub: null, depth: 0, path: [], alternatives: [] };
}
function walk(note: NoteNode, parents: Map<string, Parent[]>): Home | null {
  const seen = new Set([note.id]);
  let frontier: { id: string; path: string[] }[] = [{ id: note.id, path: [] }];
  let fallback: Home | null = null;
  for (let depth = 1; depth <= 8 && frontier.length; depth++) {
    const next: { id: string; path: string[] }[] = [];
    for (const f of frontier) for (const p of parents.get(f.id) ?? []) if (!seen.has(p.id)) { seen.add(p.id); next.push({ id: p.id, path: [...f.path, `${p.via}→${p.id}`] }); }
    const hubs = next.filter((n) => isHub(n.id));
    const projects = hubs.filter((n) => byId.get(n.id)?.type === "Project");
    const pick = projects.length ? projects : hubs;
    if (pick.length && (projects.length || !hubTypes.has("Project"))) return { hub: pick[0].id, depth, path: pick[0].path, alternatives: pick.slice(1).map((p) => p.id) };
    if (hubs.length && !fallback) fallback = { hub: hubs[0].id, depth, path: hubs[0].path, alternatives: hubs.slice(1).map((p) => p.id) };
    frontier = next;
  }
  return fallback;
}

const homes = new Map<string, Home>();
for (const n of g.nodes) if (n.type !== "Type") homes.set(n.id, home(n));

const title = (id: string) => byId.get(id)?.title ?? id;
const children = new Map<string, string[]>();
for (const [id, h] of homes) if (h.hub) (children.get(h.hub) ?? children.set(h.hub, []).get(h.hub)!).push(id);

if (asJson) {
  process.stdout.write(JSON.stringify({ hubTypes: [...hubTypes], useHas, homes: Object.fromEntries(homes) }));
} else {
  const hubs = g.nodes.filter((n) => isHub(n.id));
  const roots = hubs.filter((n) => !homes.get(n.id)?.hub);
  const print = (id: string, indent: number) => {
    const kids = children.get(id) ?? [];
    const hubKids = kids.filter(isHub);
    const n = byId.get(id)!;
    console.log(`${"  ".repeat(indent)}${n.type === "Project" ? "◆" : "■"} ${n.title}  [${n.type}; ${kids.length - hubKids.length} notes, ${hubKids.length} sub-hubs]`);
    for (const k of hubKids) print(k, indent + 1);
  };
  console.log(`# Home hierarchy (hub types: ${[...hubTypes].join(", ")}; has as parent: ${useHas})\n`);
  for (const r of roots.sort((a, b) => (children.get(b.id)?.length ?? 0) - (children.get(a.id)?.length ?? 0))) print(r.id, 0);

  console.log("\n# Projects whose parent is a Topic (expected: a Responsibility or an umbrella Project)");
  for (const n of hubs) { const h = homes.get(n.id); if (n.type === "Project" && h?.hub && byId.get(h.hub)?.type === "Topic") console.log(`- ${n.title} → ${title(h.hub)} (${n.id}.md)`); }

  console.log("\n# Notes with more than one parent hub at the same distance (first listed wins)");
  for (const [id, h] of homes) if (h.alternatives.length) console.log(`- ${title(id)} → ${title(h.hub!)} | also: ${h.alternatives.map(title).join(", ")} (${id}.md)`);

  console.log("\n# Notes homed only through a `has` link (no belongs_to chain reaches a hub)");
  for (const [id, h] of homes) if (h.hub && h.path.some((s) => s.startsWith("has→"))) console.log(`- ${title(id)} → ${title(h.hub)} via ${h.path.join(" / ")} (${id}.md)`);

  console.log("\n# Notes with no hub at all");
  for (const [id, h] of homes) if (!h.hub) console.log(`- ${title(id)} [${byId.get(id)?.type}] (${id}.md)`);
}
