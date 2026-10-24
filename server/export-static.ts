// Export vaults as static files for the demo build (pnpm build:static, see src/staticSite.ts).
//
//   node server/export-static.ts --config vaults.json --state state --out site
//
// vaults.json lists the vaults to export, the first being the default:
//   [{ "label": "Varga Lab Brain", "path": "../second-brain-demo-cancer-lab" }, ...]   (paths relative to the file)
// --state is a folder in the layout of ~/.config/brain-graph (layouts/<slug>.json, settings/<slug>.json)
// holding the saved layout and settings each vault starts with; a vault without a layout is laid out
// in the visitor's browser. --out receives data/: vaults.json, and per vault graph.json, layout.json,
// settings.json, notes/<id>.json and files/<path> for the vault-owned images its notes show.
//
// Everything is read through the server's own handlers (server/api.ts), so the graph, links to other
// vaults, note text and asset checks are exactly what the local server would answer. Absolute vault
// paths are removed. Files in dot-folders are never exported.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import { marked } from "marked";
import { createVaultApi } from "./api.ts";
import { splitFrontmatter } from "./vault.ts";
import type { VaultGraph, VaultInfo } from "../shared/types.ts";

// pnpm passes a separating "--" through; it is not an argument.
const { values: args } = parseArgs({ args: process.argv.slice(2).filter((a) => a !== "--"), options: { config: { type: "string" }, state: { type: "string" }, out: { type: "string" } } });
if (!args.config || !args.out) {
  console.error("Usage: node server/export-static.ts --config vaults.json [--state dir] --out dir");
  process.exit(1);
}
const configDir = path.dirname(path.resolve(args.config));
const wanted = JSON.parse(await fs.readFile(args.config, "utf8")) as { label: string; path: string }[];
const out = path.join(path.resolve(args.out), "data");

// A private registry for this run: only the listed vaults, no Tolaria import, and an empty layout folder
// (with a marker file, so the server's one-time migration of a checkout's .tmp/layouts never runs).
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "brain-graph-export-"));
await fs.writeFile(path.join(tmp, "vaults.json"), JSON.stringify({ useTolaria: false, vaults: wanted.map((v) => ({ label: v.label, path: path.resolve(configDir, v.path) })) }));
await fs.mkdir(path.join(tmp, "layouts"));
await fs.writeFile(path.join(tmp, "layouts", ".keep"), "");
const api = createVaultApi({ configPath: path.join(tmp, "vaults.json"), registryPath: path.join(tmp, "no-tolaria.json"), layoutDir: path.join(tmp, "layouts") });

/** One GET through the server's handlers, without a network socket. */
function get(url: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const res = {
      statusCode: 200,
      setHeader() {},
      writeHead(status: number) {
        res.statusCode = status;
      },
      write(chunk: string | Buffer) {
        chunks.push(Buffer.from(chunk));
      },
      end(chunk?: string | Buffer) {
        if (chunk) chunks.push(Buffer.from(chunk));
        resolve({ status: res.statusCode, body: Buffer.concat(chunks) });
      },
    };
    const req = { url, method: "GET", headers: {}, on() {}, setEncoding() {} };
    api.handle(req as unknown as IncomingMessage, res as unknown as ServerResponse).then((handled) => !handled && reject(new Error(`no route for ${url}`)), reject);
  });
}
const getJson = async <T>(url: string): Promise<T> => {
  const r = await get(url);
  if (r.status !== 200) throw new Error(`${url}: HTTP ${r.status} ${r.body.toString()}`);
  return JSON.parse(r.body.toString()) as T;
};
const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
const hidden = (rel: string) => rel.split("/").some((s) => s.startsWith("."));
const write = async (file: string, data: string | Buffer) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
};
const readState = async (kind: "layouts" | "settings", slug: string) => (args.state ? fs.readFile(path.join(args.state, kind, `${slug}.json`), "utf8").catch(() => null) : null);

try {
  const { vaults } = await getJson<{ vaults: VaultInfo[] }>("/api/vaults");
  if (vaults.length !== wanted.length) throw new Error(`expected ${wanted.length} vaults, the server lists ${vaults.length}: check the paths in ${args.config}`);
  await fs.rm(out, { recursive: true, force: true });
  const notesBySlug = new Map<string, Set<string>>();
  const bridges: { from: string; to: string }[] = [];
  for (const v of vaults) {
    const dir = path.join(out, v.slug);
    const q = `vault=${encodeURIComponent(v.slug)}`;
    const graph = await getJson<VaultGraph>(`/api/graph?${q}`);
    await write(path.join(dir, "graph.json"), JSON.stringify({ ...graph, vault: { ...graph.vault, path: "" } }));
    notesBySlug.set(v.slug, new Set(graph.nodes.map((n) => n.id)));
    for (const b of graph.bridges ?? []) bridges.push({ from: `${v.slug}/${b.from}`, to: `${b.vault}/${b.path.replace(/\.md$/, "")}` });

    // Images are found as the panel finds them: rendered Markdown, relative src, resolved from the vault root.
    const assets = new Set<string>();
    for (const n of graph.nodes) {
      const note = await get(`/api/note?${q}&id=${encodeURIComponent(n.id)}`);
      if (note.status !== 200) throw new Error(`${v.label}: note ${n.id}: HTTP ${note.status}`);
      await write(path.join(dir, "notes", `${n.id}.json`), note.body);
      const html = marked.parse(splitFrontmatter((JSON.parse(note.body.toString()) as { markdown: string }).markdown).body, { async: false, gfm: true }) as string;
      for (const m of html.matchAll(/src="(?!https?:|data:|\/)([^"]+)"/g)) assets.add(m[1]);
    }
    let copied = 0;
    for (const rel of assets) {
      if (hidden(rel)) {
        console.warn(`${v.label}: skipped ${rel} (in a dot-folder)`);
        continue;
      }
      const r = await get(`/vault-file/${enc(rel)}?${q}`);
      if (r.status !== 200) {
        console.warn(`${v.label}: image ${rel} not found (HTTP ${r.status})`);
        continue;
      }
      await write(path.join(dir, "files", rel), r.body);
      copied++;
    }

    const layout = await readState("layouts", v.slug);
    if (layout) {
      const { savedAt, positions } = JSON.parse(layout) as { savedAt: string; positions: Record<string, [number, number]> };
      await write(path.join(dir, "layout.json"), JSON.stringify({ savedAt, positions }));
    } else console.warn(`${v.label}: no saved layout in --state; visitors' browsers will lay it out`);
    await write(path.join(dir, "settings.json"), (await readState("settings", v.slug)) ?? "{}");
    console.log(`${v.label} (${v.slug}): ${graph.nodes.length} notes, ${graph.edges.length} links, ${graph.bridges?.length ?? 0} links to other vaults, ${copied} images${layout ? ", saved layout" : ""}`);
  }
  for (const b of bridges) {
    const [slug, ...id] = b.to.split("/");
    if (!notesBySlug.get(slug)?.has(id.join("/"))) console.warn(`link ${b.from} -> ${b.to}: target note is not exported`);
  }
  await write(path.join(out, "vaults.json"), JSON.stringify(vaults.map((v, i) => ({ slug: v.slug, label: v.label, path: "", isDefault: i === 0, source: "manual" }))));
} finally {
  await api.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
