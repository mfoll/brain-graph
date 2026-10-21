import type { Plugin, ViteDevServer } from "vite";
import chokidar from "chokidar";
import path from "node:path";
import { buildGraph, type VaultGraph } from "./vault.ts";

export interface VaultPluginOptions {
  vaultPath: string;
  label?: string;
  /** Tolaria vault slug used in tolaria://<slug>/<path> deep links. Defaults to a slugified label. */
  slug?: string;
}

/**
 * Serves the parsed vault graph at /api/graph and pushes "changed" events on
 * /api/events (Server-Sent Events) whenever a Markdown file in the vault changes.
 */
export function vaultPlugin(opts: VaultPluginOptions): Plugin {
  const vaultPath = path.resolve(opts.vaultPath.replace(/^~(?=$|\/)/, process.env.HOME ?? ""));
  let cache: Promise<VaultGraph> | null = null;
  const clients = new Set<import("node:http").ServerResponse>();

  const invalidate = () => {
    cache = null;
    for (const res of clients) res.write(`event: changed\ndata: ${Date.now()}\n\n`);
  };
  const graph = () => (cache ??= buildGraph(vaultPath, opts.label, opts.slug));

  return {
    name: "brain-graph-vault",
    configureServer(server: ViteDevServer) {
      const watcher = chokidar.watch(vaultPath, {
        ignored: (p, stats) => {
          const base = path.basename(p);
          if (p !== vaultPath && base.startsWith(".")) return true;
          return !!stats?.isFile() && !p.endsWith(".md");
        },
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 200 },
      });
      let timer: NodeJS.Timeout | null = null;
      watcher.on("all", () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(invalidate, 250);
      });
      server.httpServer?.on("close", () => watcher.close());

      server.middlewares.use("/api/graph", async (_req, res) => {
        try {
          const g = await graph();
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(g));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      server.middlewares.use("/api/events", (req, res) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(": connected\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
      });
    },
  };
}
