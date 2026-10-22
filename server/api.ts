/**
 * Brain Graph's local API: vault registry, parsed graphs, note text, vault assets, saved layouts and
 * change events. Framework-free so the same code serves the Vite dev server and the `brain-graph` CLI.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import chokidar from "chokidar";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { firstH1, buildGraph, slugify, type VaultGraph } from "./vault.ts";
import type { Bridge, VaultInfo } from "../shared/types.ts";

export interface VaultApiOptions {
  /** Extra vault to serve (typically from the VAULT env var); registered Tolaria vaults are added automatically. */
  vaultPath?: string;
  /** More folders to serve (command line arguments); the first `vaultPath` stays the default. */
  vaultPaths?: string[];
  label?: string;
  /** Tolaria vault slug used in tolaria://<slug>/<path> deep links. Defaults to a slugified label. */
  slug?: string;
  /** Frontmatter keys whose values are paths into another registered vault (default archive_record, archive_records). */
  bridgeKeys?: string[];
  /** Directory for the saved layout sidecars (one per vault slug). Defaults to ~/.config/brain-graph/layouts. */
  layoutDir?: string;
  /** Tolaria registry; defaults to the macOS location. */
  registryPath?: string;
  /** Brain Graph's own registry of manually added vaults; defaults to ~/.config/brain-graph/vaults.json. */
  configPath?: string;
}

interface ManualRegistry {
  vaults: { label: string; path: string }[];
  /** Include the vaults registered in Tolaria (default true when a registry exists). */
  useTolaria: boolean;
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

const configFile = (opts: VaultApiOptions) => expand(opts.configPath ?? path.join(os.homedir(), ".config", "brain-graph", "vaults.json"));

async function readManual(opts: VaultApiOptions): Promise<ManualRegistry> {
  try {
    const v = JSON.parse(await fs.readFile(configFile(opts), "utf8")) as Partial<ManualRegistry>;
    return { vaults: Array.isArray(v.vaults) ? v.vaults : [], useTolaria: v.useTolaria !== false };
  } catch {
    return { vaults: [], useTolaria: true };
  }
}
async function writeManual(opts: VaultApiOptions, reg: ManualRegistry): Promise<void> {
  const file = configFile(opts);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(reg, null, 2));
}

/** A folder counts as a vault when it exists and holds at least one Markdown file (shallow or one level down). */
async function looksLikeVault(dir: string): Promise<boolean> {
  try {
    if (!(await fs.stat(dir)).isDirectory()) return false;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && e.name.endsWith(".md"))) return true;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const sub = await fs.readdir(path.join(dir, e.name)).catch(() => []);
      if (sub.some((f) => f.endsWith(".md"))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Vaults the server is allowed to serve: folders added by hand (Brain Graph's own registry), Tolaria's
 * registered and mounted vaults when that import is on, and the env vault (if any).
 */
async function discoverVaults(opts: VaultApiOptions): Promise<VaultInfo[]> {
  const out = new Map<string, VaultInfo>();
  const manual = await readManual(opts);
  const registryPath = opts.registryPath ?? path.join(os.homedir(), "Library", "Application Support", "com.tolaria.app", "vaults.json");
  let registry: TolariaRegistry = {};
  if (manual.useTolaria) {
    try {
      registry = JSON.parse(await fs.readFile(registryPath, "utf8")) as TolariaRegistry;
    } catch {
      // no Tolaria registry
    }
  }
  for (const v of registry.vaults ?? []) {
    if (v.mounted === false) continue;
    const p = expand(v.path);
    if (!(await looksLikeVault(p))) continue;
    out.set(p, { slug: slugify(v.label), label: v.label, path: p, isDefault: registry.default_workspace_path ? expand(registry.default_workspace_path) === p : false, source: "tolaria" });
  }
  for (const v of manual.vaults) {
    const p = expand(v.path);
    if (!(await looksLikeVault(p))) continue;
    const existing = out.get(p);
    out.set(p, { slug: slugify(v.label), label: v.label, path: p, isDefault: existing?.isDefault ?? false, source: "manual" });
  }
  for (const extra of opts.vaultPaths ?? []) {
    const p = expand(extra);
    if (!(await looksLikeVault(p))) continue;
    const existing = out.get(p);
    out.set(p, { slug: existing?.slug ?? slugify(path.basename(p)), label: existing?.label ?? path.basename(p), path: p, isDefault: existing?.isDefault ?? false, source: existing?.source ?? "env" });
  }
  if (opts.vaultPath) {
    const p = expand(opts.vaultPath);
    const existing = out.get(p);
    const label = opts.label ?? existing?.label ?? path.basename(p);
    // The VAULT env var only chooses the default; a vault also known from Tolaria or added by hand keeps that origin.
    out.set(p, { slug: opts.slug ?? existing?.slug ?? slugify(label), label, path: p, isDefault: true, source: existing?.source ?? "env" });
    for (const v of out.values()) if (v.path !== p) v.isDefault = false;
  }
  const list = [...out.values()];
  // Slugs must be unique: disambiguate collisions with a numeric suffix.
  const seen = new Map<string, number>();
  for (const v of list) {
    const n = (seen.get(v.slug) ?? 0) + 1;
    seen.set(v.slug, n);
    if (n > 1) v.slug = `${v.slug}-${n}`;
  }
  if (list.length && !list.some((v) => v.isDefault)) list[0].isDefault = true;
  return list;
}

/**
 * Serves the parsed graph of any allowed vault (`?vault=<slug>`), the raw Markdown of a note, vault
 * assets, and a saved layout per vault; pushes "changed" events over SSE when a vault's Markdown changes.
 */
export function createVaultApi(opts: VaultApiOptions = {}) {
  const layoutDir = expand(opts.layoutDir ?? path.join(os.homedir(), ".config", "brain-graph", "layouts"));
  // One-time migration from the former location inside a development checkout.
  const legacyDir = path.join(process.cwd(), ".tmp", "layouts");
  const migrated = (async () => {
    try {
      const have = await fs.readdir(layoutDir).catch(() => [] as string[]);
      if (have.length) return;
      const old = await fs.readdir(legacyDir).catch(() => [] as string[]);
      if (!old.length) return;
      await fs.mkdir(layoutDir, { recursive: true });
      for (const f of old) if (f.endsWith(".json")) await fs.copyFile(path.join(legacyDir, f), path.join(layoutDir, f));
    } catch {
      /* best effort */
    }
  })();
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
  // Cross-vault pointers: a path listed under a bridge key is looked up in every other registered vault
  // (as <path>/record.md, <path>.md or <path>); the target's H1 becomes the bridge node's label.
  const bridgeKeys = opts.bridgeKeys ?? ["archive_record", "archive_records"];
  const resolveBridges = async (data: VaultGraph, all: VaultInfo[]): Promise<Bridge[]> => {
    const others = all.filter((v) => v.slug !== data.vault.slug);
    const found = new Map<string, Promise<{ vault: string; path: string; title: string } | null>>();
    const lookup = (raw: string) => {
      const p = raw.trim().replace(/^\/+/, "").replace(/\/record\.md$/, "").replace(/\.md$/, "");
      if (!p) return Promise.resolve(null);
      let hit = found.get(p);
      if (!hit) {
        hit = (async () => {
          for (const v of others) {
            for (const rel of [`${p}/record.md`, `${p}.md`, p]) {
              const file = path.join(v.path, rel);
              const text = await fs.readFile(file, "utf8").catch(() => null);
              if (text === null) continue;
              const body = text.startsWith("---") ? text.split(/^---\s*$/m, 3)[2] ?? text : text;
              return { vault: v.slug, path: rel, title: firstH1(body) ?? path.basename(p) };
            }
          }
          return null;
        })();
        found.set(p, hit);
      }
      return hit;
    };
    const out: Bridge[] = [];
    for (const n of data.nodes) {
      for (const key of bridgeKeys) {
        const value = n.properties[key];
        const raws = Array.isArray(value) ? value : value ? [value] : [];
        for (const raw of raws) {
          if (typeof raw !== "string") continue;
          const t = await lookup(raw);
          if (t) out.push({ from: n.id, ...t, kind: raw.trim().replace(/^\/+/, "").split("/")[0] || "record" });
        }
      }
    }
    return out;
  };
  const graph = (info: VaultInfo) => {
    watch(info);
    let g = caches.get(info.slug);
    if (!g) {
      g = buildGraph(info.path, info.label, info.slug).then(async (data) => ({ ...data, bridges: await resolveBridges(data, await vaults()) }));
      caches.set(info.slug, g);
    }
    return g;
  };
  const json = (res: import("node:http").ServerResponse, body: unknown, status = 200) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };

  type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<unknown> | unknown;
  const routes: [string, Handler][] = [];

      // Registry: GET lists {vaults, useTolaria, tolariaAvailable}; POST {path,label?} adds a folder;
      // DELETE ?path= removes a manually added folder; PUT {useTolaria} toggles the Tolaria import.
  routes.push(["/api/vaults", async (req, res) => {
    try {
      const manual = await readManual(opts);
      const tolariaAvailable = await fs
        .stat(opts.registryPath ?? path.join(os.homedir(), "Library", "Application Support", "com.tolaria.app", "vaults.json"))
        .then(() => true)
        .catch(() => false);
      if (req.method === "POST") {
        const body = JSON.parse(await readBody(req)) as { path?: string; label?: string };
        const p = expand(body.path ?? "");
        if (!body.path || !(await looksLikeVault(p))) return json(res, { error: "That folder does not exist or holds no Markdown notes." }, 400);
        if (!manual.vaults.some((v) => expand(v.path) === p)) manual.vaults.push({ path: p, label: body.label?.trim() || path.basename(p) });
        await writeManual(opts, manual);
        vaultsPromise = null;
      } else if (req.method === "DELETE") {
        const url = new URL(req.url ?? "", "http://localhost");
        const p = expand(url.searchParams.get("path") ?? "");
        manual.vaults = manual.vaults.filter((v) => expand(v.path) !== p);
        await writeManual(opts, manual);
        vaultsPromise = null;
      } else if (req.method === "PUT") {
        const body = JSON.parse(await readBody(req)) as { useTolaria?: boolean };
        if (typeof body.useTolaria === "boolean") manual.useTolaria = body.useTolaria;
        await writeManual(opts, manual);
        vaultsPromise = null;
      }
      json(res, { vaults: await vaults(), useTolaria: manual.useTolaria, tolariaAvailable, configPath: configFile(opts) });
    } catch (err) {
      json(res, { error: String(err) }, 500);
    }
  }]);

  routes.push(["/api/graph", async (req, res) => {
    try {
      const v = await resolveVault(req);
      if (!v) return json(res, { error: "unknown vault" }, 404);
      json(res, await graph(v.info));
    } catch (err) {
      json(res, { error: String(err) }, 500);
    }
  }]);

      // Raw Markdown of one note: /api/note?vault=<slug>&id=<vault-relative id without .md>
  routes.push(["/api/note", async (req, res) => {
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
  }]);

      // Vault-owned assets referenced from notes: /vault-file/<relative path>?vault=<slug>
  routes.push(["/vault-file", async (req, res) => {
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
  }]);

      // Swap the saved layout with its previous version (the current one becomes the previous).
  routes.push(["/api/layout/restore", async (req, res) => {
    try {
      const v = await resolveVault(req);
      if (!v) return json(res, { error: "unknown vault" }, 404);
      const file = path.join(layoutDir, `${v.info.slug}.json`);
      const prev = path.join(layoutDir, `${v.info.slug}.prev.json`);
      const [cur, old] = await Promise.all([fs.readFile(file, "utf8").catch(() => null), fs.readFile(prev, "utf8").catch(() => null)]);
      if (old === null) return json(res, { error: "no previous layout" }, 404);
      await fs.writeFile(file, old);
      if (cur !== null) await fs.writeFile(prev, cur);
      res.setHeader("Content-Type", "application/json");
      res.end(old);
    } catch (err) {
      json(res, { error: String(err) }, 500);
    }
  }]);

      // Saved layout positions per vault: GET returns {savedAt, positions, hasPrevious} or 404; PUT stores
      // (keeping the previous version as <slug>.prev.json); DELETE removes.
  routes.push(["/api/layout", async (req, res) => {
    try {
      const v = await resolveVault(req);
      if (!v) return json(res, { error: "unknown vault" }, 404);
      const file = path.join(layoutDir, `${v.info.slug}.json`);
      const prev = path.join(layoutDir, `${v.info.slug}.prev.json`);
      const hasPrevious = () => fs.stat(prev).then(() => true).catch(() => false);
      if (req.method === "GET") {
        const text = await fs.readFile(file, "utf8").catch(() => null);
        if (text === null) return json(res, {}, 404);
        return json(res, { ...(JSON.parse(text) as SavedLayout), hasPrevious: await hasPrevious() });
      }
      if (req.method === "PUT") {
        const body = JSON.parse(await readBody(req)) as Partial<SavedLayout>;
        if (!body || typeof body.positions !== "object") throw new Error("positions missing");
        const saved: SavedLayout = { savedAt: new Date().toISOString(), positions: body.positions as SavedLayout["positions"] };
        await fs.mkdir(layoutDir, { recursive: true });
        // Keep the previous version, but only when the layout really changed (not for a repeated save of the same map).
        const current = await fs.readFile(file, "utf8").catch(() => null);
        if (current !== null) {
          const curPos = (JSON.parse(current) as SavedLayout).positions ?? {};
          const ids = Object.keys(curPos);
          let moved = 0;
          for (const id of ids) {
            const a = curPos[id];
            const b = saved.positions[id];
            if (!b || Math.hypot(a[0] - b[0], a[1] - b[1]) > 1) moved++;
          }
          if (moved > ids.length * 0.01) await fs.writeFile(prev, current);
        }
        await fs.writeFile(file, JSON.stringify(saved));
        return json(res, { savedAt: saved.savedAt, count: Object.keys(saved.positions).length, hasPrevious: await hasPrevious() });
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
  }]);

  routes.push(["/api/events", async (req, res) => {
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
  }]);

  /** Serve an API request; resolves false when the URL is not ours (the caller serves static files then). */
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    await migrated;
    const original = req.url ?? "/";
    const pathname = new URL(original, "http://localhost").pathname;
    for (const [prefix, handler] of routes) {
      if (pathname === prefix || pathname.startsWith(prefix + "/")) {
        // Like connect's mounting: the handler sees the URL relative to its prefix.
        req.url = original.slice(prefix.length) || "/";
        try {
          await handler(req, res);
        } finally {
          req.url = original;
        }
        return true;
      }
    }
    return false;
  };
  const close = async () => {
    for (const w of watchers.values()) await w.close();
  };
  return { handle, close, vaults, layoutDir };
}
