import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { rm } from "node:fs/promises";
import path from "node:path";
import { vaultPlugin } from "./server/vite-plugin-vault.ts";

// Vaults come from Brain Graph's own registry (~/.config/brain-graph/vaults.json, edited in the app),
// from Tolaria's registry when present, and from `VAULT=~/some/vault pnpm dev` (which also makes it the
// default). With none of these, the app opens on the vault manager.
const vaultPath = process.env.VAULT;

// `vite build --mode static` (pnpm build:static) builds the static demo into dist-static/: relative URLs,
// no local server, and without the files that only make sense with one (the service worker that explains
// how to start the server, and the installable-app manifest). See src/staticSite.ts.
function staticSite(): Plugin {
  let outDir = "";
  return {
    name: "brain-graph-static",
    apply: "build",
    configResolved: (config) => void (outDir = path.resolve(config.root, config.build.outDir)),
    transformIndexHtml: (html) => html.replace(/\s*<link rel="manifest"[^>]*>/, ""),
    closeBundle: async () => {
      for (const f of ["sw.js", "offline.html", "manifest.webmanifest"]) await rm(path.join(outDir, f), { force: true });
    },
  };
}

export default defineConfig(({ mode }) =>
  mode === "static"
    ? { base: "./", plugins: [react(), staticSite()], build: { outDir: "dist-static" } }
    : {
        plugins: [react(), vaultPlugin({ vaultPath, label: process.env.VAULT_LABEL, slug: process.env.VAULT_SLUG })],
        server: { port: 5178, strictPort: true, open: false },
      },
);
