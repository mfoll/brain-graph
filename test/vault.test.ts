// Parser and group inference on a small vault that uses the Tolaria and Second Brain template conventions.
// Run with: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { buildGraph } from "../server/vault.ts";
import { DEFAULT_HUB_TYPES, buildHomeIndex, isUnassigned } from "../src/graph/home.ts";

const vault = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const g = await buildGraph(vault, "Fixture", "fixture");
const has = (source: string, target: string, kind: string) => g.edges.some((e) => e.source === source && e.target === target && e.kind === kind);

test("reads every note, with folder paths as ids and H1s as titles", () => {
  assert.equal(g.nodes.length, 12);
  const nested = g.nodes.find((n) => n.id === "folder/nested-note");
  assert.ok(nested, "folder note is read");
  assert.equal(nested.title, "Nested Note");
  assert.equal(nested.folder, "folder");
});

test("frontmatter wikilinks become relationships, text wikilinks become body links", () => {
  assert.ok(has("alpha-project", "maintain-research", "belongs_to"));
  assert.ok(has("beta-source", "alpha-project", "belongs_to"), "alias form [[target|label]] resolves");
  assert.ok(has("beta-source", "gamma-topic", "related_to"));
  assert.ok(has("gamma-topic", "delta-note", "has"));
  assert.ok(has("beta-source", "alpha-project", "body"), "anchor form [[target#heading|label]] resolves");
  assert.ok(has("zeta-note", "folder/nested-note", "belongs_to"), "a unique stem resolves to a folder note");
  assert.deepEqual(
    g.unresolved.map((u) => u.raw),
    ["missing-note"],
  );
});

test("group inference follows the template's hierarchy rules", () => {
  const index = buildHomeIndex(g, { hubTypes: new Set(DEFAULT_HUB_TYPES), useHas: true });
  const home = (id: string) => index.homes.get(id);
  const node = (id: string) => g.nodes.find((n) => n.id === id)!;

  assert.equal(home("beta-source")?.hub, "alpha-project");
  assert.equal(home("zeta-note")?.hub, "alpha-project", "a note under a non-group note reaches its group");
  assert.equal(index.hubs.get("alpha-project")?.parent, "maintain-research");
  assert.deepEqual([...index.roots].sort(), ["gamma-topic", "maintain-research"]);

  assert.equal(home("delta-note")?.hub, "gamma-topic", "has is a fallback when no parent link exists");
  assert.equal(home("delta-note")?.viaHas, true);

  for (const id of ["epsilon-guide", "inbox-capture", "weekly-hours"]) assert.equal(home(id)?.exempt, true, `${id} is outside the hierarchy`);
  assert.equal(isUnassigned(node("orphan-question"), index), true);
  assert.equal(isUnassigned(node("epsilon-guide"), index), false, "outside is not unassigned");
});
