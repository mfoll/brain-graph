// Audit dump of the home hierarchy the viewer infers (same code as the viewer: src/graph/home.ts).
// Usage: pnpm graph:homes [vault-path] [--no-has] [--hubs=Project,Responsibility,Topic] [--json]
import { buildGraph } from "./vault.ts";
import { acceptsDoubleParent, buildHomeIndex, isFlaggedRoot, isUnassigned, outsideReason } from "../src/graph/home.ts";

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
  console.log(`# Home hierarchy (hub types: ${[...hubTypes].join(", ")}; has as parent: ${useHas}; Responsibilities and hierarchy_root Topics are roots; Recaps, Guides, Operations, hierarchy_exempt types, archived and Inbox notes are outside)\n`);
  for (const r of index.roots) print(r, 0);

  // The four lists match the warnings of the Second Brain template's hierarchy audit (project-parent, multi-parent, has-only,
  // homeless), and the closing lists its info lines for the same exceptions; both end with a SUMMARY to diff.
  const counts: Record<string, number> = { "project-parent": 0, "multi-parent": 0, "has-only": 0, homeless: 0 };
  const info: string[] = [];
  const out = (cat: string, line: string) => {
    counts[cat]++;
    console.log(line);
  };

  console.log("\n# Active Projects with no parent, or whose parent is a Topic without hierarchy_root: true (in the Second Brain template, Topics are lateral context)");
  for (const h of hubs.values()) {
    const n = byId.get(h.id)!;
    if (h.type !== "Project" || n.archived) continue;
    const p = h.parent ? byId.get(h.parent) : null;
    if (!p) out("project-parent", `- ${h.title} has no parent group (${h.id}.md)`);
    else if (p.type === "Topic" && !isFlaggedRoot(p)) out("project-parent", `- ${h.title} → ${p.title} (${h.id}.md)`);
  }

  console.log("\n# Notes with more than one parent hub at the same distance (first listed wins; accepted_double_parent: true listed at the end)");
  for (const [id, h] of homes) {
    if (!h.alternatives.length) continue;
    const line = `- ${title(id)} → ${title(h.hub!)} | also: ${h.alternatives.map(title).join(", ")} (${id}.md)`;
    if (acceptsDoubleParent(byId.get(id))) info.push(`${line} [accepted_double_parent]`);
    else out("multi-parent", line);
  }

  console.log("\n# Notes homed only through a `has` link (no belongs_to chain reaches a hub)");
  for (const [id, h] of homes) if (h.viaHas) out("has-only", `- ${title(id)} → ${title(h.hub!)} via ${h.path.map((p) => `${p.via}→${title(p.id)}`).join(" / ")} (${id}.md)`);

  console.log("\n# Notes with no hub at all (exempt types, archived and Inbox notes, and parentless Persons left out)");
  for (const n of byId.values()) if (isUnassigned(n, index) && n.type !== "Project") out("homeless", `- ${n.title} [${n.type}] (${n.id}.md)`);

  for (const n of byId.values()) if (isFlaggedRoot(n) && n.type === "Topic") info.push(`- ${n.title} roots an area [hierarchy_root] (${n.id}.md)`);
  for (const [id, h] of homes) if (h.lateral) info.push(`- ${title(id)} has no belongs_to; coloured by its first related group ${title(h.hub!)} [person-no-affiliation] (${id}.md)`);
  for (const n of byId.values()) if (!n.archived && outsideReason(n, index) === "no affiliation group") info.push(`- ${n.title} has no belongs_to and no related group; outside the hierarchy [person-no-affiliation] (${n.id}.md)`);
  console.log(`\n# Deliberate exceptions (INFO, not counted)`);
  for (const l of info) console.log(l);

  const warnings = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`\nSUMMARY\t${Object.entries(counts).filter(([, v]) => v).map(([k, v]) => `${k}=${v}\t`).join("")}warnings=${warnings}\tinfo=${info.length}`);
}
