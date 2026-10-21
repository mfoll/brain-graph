import type { Plugin, ViteDevServer } from "vite";
import chokidar from "chokidar";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildGraph, slugify, type VaultGraph } from "./vault.ts";
import type { VaultInfo } from "../shared/types.ts";

export interface VaultPluginOptions {
  /** Extra vault to serve (typically from the VAULT env var); registered Tolaria vaults are added automatically. */
  vaultPath?: string;
  label?: string;
  /** Tolaria vault slug used in tolaria://<slug>/<path> deep links. Defaults to a slugified label. */
  slug?: string;
  /** Directory for the saved layout sidecars (one per vault slug). Defaults to <cwd>/.tmp/layouts. */
  layoutDir?: string;
  /** Tolaria registry; defaults to the macOS location. */
  registryPath?: string;
}

export interface SavedLayout {
  savedAt: string;
  positions: Record<string, [number, number]>;
}

const expand = (p: string) => path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

interface TolariaRegistry {
  vaults?: { label: string; path: string; mounted?: boolean }[];
  default_workspace_path?: string;
}

/** Vaults the server is allowed to serve: the env vault (if any) plus Tolaria's registered, mounted vaults. */
async function discoverVaults(opts: VaultPluginOptions): Promise<VaultInfo[]> {
  const out = new Map<string, VaultInfo>();
  const registryPath = opts.registryPath ?? path.join(os.homedir(), "Library", "Application Support", "com.tolaria.app", "vaults.json");
  let registry: TolariaRegistry = {};
  try {
    registry = JSON.parse(await fs.readFile(registryPath, "utf8")) as TolariaRegistry;
  } catch {
    // no Tolaria registry: only the env vault is served
  }
  for (const v of registry.vaults ?? []) {
    if (v.mounted === false) continue;
    const p = expand(v.path);
    try {
      if (!(await fs.stat(p)).isDirectory()) continue;
    } catch {
      continue;
    }
    out.set(p, { slug: slugify(v.label), label: v.label, path: p, isDefault: registry.default_workspace_path ? expand(registry.default_workspace_path) === p : false });
  }
  if (opts.vaultPath) {
    const p = expand(opts.vaultPath);
    const existing = out.get(p);
    const label = opts.label ?? existing?.label ?? path.basename(p);
    out.set(p, { slug: opts.slug ?? existing?.slug ?? slugify(label), label, path: p, isDefault: true });
    for (const v of out.values()) if (v.path !== p) v.isDefault = false;
  }
  const list = [...out.values()];
  if (list.length && !list.some((v) => v.isDefault)) list[0].isDefault = true;
  return list;
}

/**
 * Serves the parsed graph of any allowed vault (`?vault=<slug>`), the raw Markdown of a note, vault
 * assets, and a saved layout per vault; pushes "changed" events over SSE when a vault's Markdown changes.
 */
export function vaultPlugin(opts: VaultPluginOptions = {}): Plugin {
  const layoutDir = path.resolve(opts.layoutDir ?? path.join(process.cwd(), ".tmp", "layouts"));
  let vaultsPromise: Promise<VaultInfo[]> | null = null;
  const vaults = () => (vaultsPromise ??= discoverVaults(opts));
  const caches = new Map<string, Promise<VaultGraph>>();
  const watchers = new Map<string, ReturnType<typeof chokidar.watch>>();
  const clients = new Map<string, Set<import("node:http").ServerResponse>>();

  const resolveVault = async (req: import("node:http").IncomingMessage): Promise<{ info: VaultInfo; url: URL } | null> => {
    const url = new URL(req.url ?? "", "http://localhost");
    const slug = url.searchParams.get("vault");
    const list = await vaults();
    const info = slug ? list.find((v) => v.slug === slug) : list.find((v) => v.isDefault);
    return info ? { info, url } : null;
  };

  const watch = (info: VaultInfo) => {
    if (watchers.has(info.slug)) return;
    const watcher = chokidar.watch(info.path, {
      ignored: (p, stats) => {
        const base = path.basename(p);
        if (p !== info.path && base.startsWith(".")) return true;
        return !!stats?.isFile() && !p.endsWith(".md");
      },
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200 },
    });
    let timer: NodeJS.Timeout | null = null;
    watcher.on("all", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        caches.delete(info.slug);
        for (const res of clients.get(info.slug) ?? []) res.write(`event: changed\ndata: ${Date.now()}\n\n`);
      }, 250);
    });
    watchers.set(info.slug, watcher);
  };
  const graph = (info: VaultInfo) => {
    watch(info);
    let g = caches.get(info.slug);
    if (!g) {
      g = buildGraph(info.path, info.label, info.slug);
      caches.set(info.slug, g);
    }
    return g;
  };
  const json = (res: import("node:http").ServerResponse, body: unknown, status = 200) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };

  return {
    name: "brain-graph-vault",
    configureServer(server: ViteDevServer) {
      server.httpServer?.on("close", () => {
        for (const w of watchers.values()) void w.close();
      });

      server.middlewares.use("/api/vaults", async (_req, res) => {
        try {
          json(res, await vaults());
        } catch (err) {
          json(res, { error: String(err) }, 500);
        }
      });

      server.middlewares.use("/api/graph", async (req, res) => {
        try {
          const v = await resolveVault(req);
          if (!v) return json(res, { error: "unknown vault" }, 404);
          json(res, await graph(v.info));
        } catch (err) {
          json(res, { error: String(err) }, 500);
        }
      });

      // Raw Markdown of one note: /api/note?vault=<slug>&id=<vault-relative id without .md>
      server.middlewares.use("/api/note", async (req, res) => {
        try {
          const v = await resolveVault(req);
          if (!v) return json(res, { error: "unknown vault" }, 404);
          const id = v.url.searchParams.get("id") ?? "";
          const file = path.resolve(v.info.path, `${id}.md`);
          if (!id || id.includes("..") || !file.startsWith(v.info.path + path.sep) || !file.endsWith(".md")) return json(res, { error: "bad id" }, 400);
          const [text, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
          json(res, { id, markdown: text, modified: stat.mtime.toISOString() });
        } catch (err) {
          json(res, { error: String(err) }, (err as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500);
        }
      });

      // Vault-owned assets referenced from notes: /vault-file/<relative path>?vault=<slug>
      server.middlewares.use("/vault-file", async (req, res) => {
        try {
          const v = await resolveVault(req);
          if (!v) {
            res.statusCode = 404;
            return res.end();
          }
          const rel = decodeURIComponent(v.url.pathname).replace(/^\/+/, "");
          const file = path.resolve(v.info.path, rel);
          if (!rel || rel.includes("..") || !file.startsWith(v.info.path + path.sep) || /\.md$/i.test(file)) {
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

      // Saved layout positions per vault: GET returns {savedAt, positions} or 404; PUT stores; DELETE removes.
      server.middlewares.use("/api/layout", async (req, res) => {
        try {
          const v = await resolveVault(req);
          if (!v) return json(res, { error: "unknown vault" }, 404);
          const file = path.join(layoutDir, `${v.info.slug}.json`);
          if (req.method === "GET") {
            const text = await fs.readFile(file, "utf8").catch(() => null);
            if (text === null) return json(res, {}, 404);
            res.setHeader("Content-Type", "application/json");
            return res.end(text);
          }
          if (req.method === "PUT") {
            const body = JSON.parse(await readBody(req)) as Partial<SavedLayout>;
            if (!body || typeof body.positions !== "object") throw new Error("positions missing");
            const saved: SavedLayout = { savedAt: new Date().toISOString(), positions: body.positions as SavedLayout["positions"] };
            await fs.mkdir(layoutDir, { recursive: true });
            await fs.writeFile(file, JSON.stringify(saved));
            return json(res, { savedAt: saved.savedAt, count: Object.keys(saved.positions).length });
          }
          if (req.method === "DELETE") {
            await fs.rm(file, { force: true });
            res.statusCode = 204;
            return res.end();
          }
          res.statusCode = 405;
          res.end();
        } catch (err) {
          json(res, { error: String(err) }, 500);
        }
      });

      server.middlewares.use("/api/events", async (req, res) => {
        const v = await resolveVault(req);
        if (!v) {
          res.statusCode = 404;
          return res.end();
        }
        watch(v.info);
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": connected\n\n");
        const set = clients.get(v.info.slug) ?? clients.set(v.info.slug, new Set()).get(v.info.slug)!;
        set.add(res);
        req.on("close", () => set.delete(res));
      });
    },
  };
}
