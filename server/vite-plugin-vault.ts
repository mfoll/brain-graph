import type { Plugin, ViteDevServer } from "vite";
import chokidar from "chokidar";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildGraph, type VaultGraph } from "./vault.ts";

export interface VaultPluginOptions {
  vaultPath: string;
  label?: string;
  /** Tolaria vault slug used in tolaria://<slug>/<path> deep links. Defaults to a slugified label. */
  slug?: string;
  /** Directory for the saved layout sidecar (positions per vault). Defaults to <cwd>/.tmp/layouts. */
  layoutDir?: string;
}

export interface SavedLayout {
  savedAt: string;
  positions: Record<string, [number, number]>;
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
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
  const layoutDir = path.resolve(opts.layoutDir ?? path.join(process.cwd(), ".tmp", "layouts"));
  const layoutFile = async () => path.join(layoutDir, `${(await graph()).vault.slug}.json`);

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
      // Raw Markdown of one note: /api/note?id=<vault-relative id without .md>
      server.middlewares.use("/api/note", async (req, res) => {
        try {
          const url = new URL(req.url ?? "", "http://localhost");
          const id = url.searchParams.get("id") ?? "";
          const file = path.resolve(vaultPath, `${id}.md`);
          // Stay inside the vault and only serve Markdown files.
          if (!id || id.includes("..") || !file.startsWith(vaultPath + path.sep) || !file.endsWith(".md")) {
            res.statusCode = 400;
            return res.end(JSON.stringify({ error: "bad id" }));
          }
          const [text, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ id, markdown: text, modified: stat.mtime.toISOString() }));
        } catch (err) {
          res.statusCode = (err as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500;
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      // Vault-owned assets referenced from notes (images in attachments/ etc.).
      server.middlewares.use("/vault-file", async (req, res) => {
        try {
          const rel = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/+/, "");
          const file = path.resolve(vaultPath, rel);
          if (!rel || rel.includes("..") || !file.startsWith(vaultPath + path.sep) || /\.md$/i.test(file)) {
            res.statusCode = 400;
            return res.end();
          }
          const ext = path.extname(file).toLowerCase();
          const types: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".pdf": "application/pdf" };
          res.setHeader("Content-Type", types[ext] ?? "application/octet-stream");
          res.end(await fs.readFile(file));
        } catch {
          res.statusCode = 404;
          res.end();
        }
      });

      // Saved layout positions: GET returns {savedAt, positions} or 404; PUT stores; DELETE removes.
      server.middlewares.use("/api/layout", async (req, res) => {
        try {
          const file = await layoutFile();
          if (req.method === "GET") {
            const text = await fs.readFile(file, "utf8").catch(() => null);
            if (text === null) {
              res.statusCode = 404;
              return res.end("{}");
            }
            res.setHeader("Content-Type", "application/json");
            return res.end(text);
          }
          if (req.method === "PUT") {
            const body = JSON.parse(await readBody(req)) as Partial<SavedLayout>;
            if (!body || typeof body.positions !== "object") throw new Error("positions missing");
            const saved: SavedLayout = { savedAt: new Date().toISOString(), positions: body.positions as SavedLayout["positions"] };
            await fs.mkdir(layoutDir, { recursive: true });
            await fs.writeFile(file, JSON.stringify(saved));
            res.setHeader("Content-Type", "application/json");
            return res.end(JSON.stringify({ savedAt: saved.savedAt, count: Object.keys(saved.positions).length }));
          }
          if (req.method === "DELETE") {
            await fs.rm(file, { force: true });
            res.statusCode = 204;
            return res.end();
          }
          res.statusCode = 405;
          res.end();
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
