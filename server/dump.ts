// Dump the parsed vault graph as JSON (for debugging or static export).
// Usage: pnpm graph:dump [vault-path] > graph.json
import { buildGraph } from "./vault.ts";

const g = await buildGraph(process.argv[2] ?? process.env.VAULT ?? ".", process.env.VAULT_LABEL, process.env.VAULT_SLUG);
if (process.argv.includes("--summary")) {
  console.log(JSON.stringify({ nodes: g.nodes.length, edges: g.edges.length, types: g.types, edgeKinds: g.edgeKinds, unresolved: g.unresolved }, null, 1));
} else {
  process.stdout.write(JSON.stringify(g));
}
