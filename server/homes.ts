// Audit dump of the home hierarchy the viewer infers (same code as the viewer: src/graph/home.ts).
// Usage: pnpm graph:homes [vault-path] [--no-has] [--hubs=Project,Responsibility,Topic] [--json]
import { buildGraph } from "./vault.ts";
import { buildHomeIndex } from "../src/graph/home.ts";

const args = process.argv.slice(2);
const vault = args.find((a) => !a.startsWith("--")) ?? process.env.VAULT ?? ".";
const useHas = !args.includes("--no-has");
const hubTypes = new Set((args.find((a) => a.startsWith("--hubs="))?.slice(7) ?? "Project,Responsibility,Topic").split(","));
const asJson = args.includes("--json");

const g = await buildGraph(vault);
const index = buildHomeIndex(g, { hubTypes, useHas });
const { hubs, homes, byId } = index;
const title = (id: string) => byId.get(id)?.title ?? id;

if (asJson) {
  process.stdout.write(JSON.stringify({ hubTypes: [...hubTypes], useHas, homes: Object.fromEntries([...homes].map(([id, h]) => [id, { ...h, path: h.path.map((p) => `${p.via}→${p.id}`) }])) }));
} else {
  const print = (id: string, indent: number) => {
    const h = hubs.get(id)!;
    console.log(`${"  ".repeat(indent)}${h.type === "Project" ? "◆" : "■"} ${h.title}  [${h.type}; ${h.directCount} notes, ${h.children.length} sub-hubs]`);
    for (const k of h.children) print(k, indent + 1);
  };
  console.log(`# Home hierarchy (hub types: ${[...hubTypes].join(", ")}; has as parent: ${useHas}; Responsibilities are roots; Recaps, Guides, Operations, hierarchy_exempt types and archived notes are outside)\n`);
  for (const r of index.roots) print(r, 0);

  console.log("\n# Projects whose parent is a Topic without hierarchy_root: true (ADR 0028: Topics are lateral context)");
  for (const h of hubs.values()) {
    const p = h.parent ? byId.get(h.parent) : null;
    if (h.type === "Project" && p?.type === "Topic" && p.properties.hierarchy_root !== true) console.log(`- ${h.title} → ${p.title} (${h.id}.md)`);
  }

  console.log("\n# Notes with more than one parent hub at the same distance (first listed wins)");
  for (const [id, h] of homes) if (h.alternatives.length) console.log(`- ${title(id)} → ${title(h.hub!)} | also: ${h.alternatives.map(title).join(", ")} (${id}.md)`);

  console.log("\n# Notes homed only through a `has` link (no belongs_to chain reaches a hub)");
  for (const [id, h] of homes) if (h.viaHas) console.log(`- ${title(id)} → ${title(h.hub!)} via ${h.path.map((p) => `${p.via}→${title(p.id)}`).join(" / ")} (${id}.md)`);

  console.log("\n# Notes with no hub at all (exempt types and archived notes left out)");
  for (const [id, h] of homes) if (!h.hub && !h.exempt && !hubs.has(id)) console.log(`- ${title(id)} [${byId.get(id)?.type}] (${id}.md)`);
}
