#!/usr/bin/env node
// Brain Graph: serve the built app and the local vault API, then open the browser.
//   npx brain-graph [folder ...] [--port 5178] [--no-open]
//   npx brain-graph install-hooks [claude] [codex] [--port 5178]    let agents report the notes they touch
//   npx brain-graph uninstall-hooks [claude] [codex]
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { openBrowser } from "./open-browser.mjs";
import { existsSync } from "node:fs";
import sirv from "sirv";
import { createVaultApi } from "../dist/server/server/api.js";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, v && !v.startsWith("--") ? 2 : 1);
  return v ?? true;
};
if (args.includes("--help") || args.includes("-h")) {
  console.log(`brain-graph [folder ...] [--port N] [--no-open]
brain-graph install-hooks [claude] [codex] [--port N]
brain-graph uninstall-hooks [claude] [codex]

Serves Brain Graph at http://localhost:<port>. Folders given here are added to the vault list for this
run (the first one is selected); vaults registered in Tolaria and folders added in the app are served too.

install-hooks adds a hook to Claude Code and Codex (all installed ones, or those named) so the notes they
read or write pulse on the map. uninstall-hooks removes it.`);
  process.exit(0);
}
if (args[0] === "install-hooks" || args[0] === "uninstall-hooks") {
  const { installHooks, uninstallHooks } = await import("./hooks.mjs");
  const sub = args.shift();
  const hookPort = Number(flag("--port") ?? 5178);
  const agents = args.filter((a) => !a.startsWith("--"));
  try {
    await (sub === "install-hooks" ? installHooks({ port: hookPort, agents }) : uninstallHooks({ agents }));
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
  process.exit(0);
}
const port = Number(flag("--port") ?? process.env.PORT ?? 5178);
const noOpen = Boolean(flag("--no-open"));
const folders = args.filter((a) => !a.startsWith("--"));

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist");
if (!existsSync(path.join(dist, "index.html"))) {
  console.error("Built app not found. Run `npm run build` first (or install from npm / with `npx github:mfoll/brain-graph`).");
  process.exit(1);
}

const api = createVaultApi({ vaultPath: folders[0] ?? process.env.VAULT, vaultPaths: folders.slice(1), label: process.env.VAULT_LABEL, slug: process.env.VAULT_SLUG });
// Files under assets/ have a content hash in their name and never change. Everything else, the page
// above all, is checked on every load, so an updated Brain Graph is picked up at the next reload.
const serveStatic = sirv(dist, {
  single: true,
  dev: false,
  etag: true,
  setHeaders: (res, pathname) => res.setHeader("Cache-Control", pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache"),
});

const server = createServer((req, res) => {
  api
    .handle(req, res)
    .then((handled) => {
      if (!handled) serveStatic(req, res);
    })
    .catch((err) => {
      res.statusCode = 500;
      res.end(String(err));
    });
});

server.listen(port, "127.0.0.1", async () => {
  const url = `http://localhost:${port}/`;
  const vaults = await api.vaults();
  console.log(`Brain Graph  ${url}`);
  console.log(vaults.length ? `Vaults: ${vaults.map((v) => `${v.label} (${v.path})`).join(", ")}` : "No vault yet: add a folder in the app (Manage vaults…) or pass one on the command line.");
  console.log(`Layouts: ${api.layoutDir}`);
  if (!noOpen) {
    openBrowser(url);
  }
});
server.on("error", (err) => {
  console.error(err.code === "EADDRINUSE" ? `Port ${port} is in use; try --port ${port + 1}.` : String(err));
  process.exit(1);
});
const stop = () => {
  server.close();
  void api.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
