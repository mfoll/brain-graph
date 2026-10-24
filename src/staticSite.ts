// The page talks to Brain Graph's local server (server/api.ts) through apiFetch and assetUrl. A static
// build (`vite build --mode static`, see `pnpm build:static`) has no server: it reads the files written
// by server/export-static.ts with relative URLs, so it works under any sub-path, and keeps layout and
// settings changes in this browser.
export const STATIC = import.meta.env.MODE === "static";

const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** URL of a vault-owned file (an image a note shows), given as a vault-relative path. */
export const assetUrl = (slug: string, rel: string) => (STATIC ? `data/${encodeURIComponent(slug)}/files/${enc(rel)}` : `/vault-file/${enc(rel)}?vault=${encodeURIComponent(slug)}`);

/** fetch() for the server's /api/ routes; in a static build, answered from exported files and this browser. */
export const apiFetch = (url: string, init?: RequestInit): Promise<Response> => (STATIC ? staticFetch(url, init) : fetch(url, init));

interface Layout {
  savedAt: string;
  positions: Record<string, [number, number]>;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// This browser's copy of a vault's layout, previous layout and settings. A key holding null means
// deleted (Reset layout); a missing key means unchanged, so the exported file applies.
type Name = "layout" | "layout.prev" | "settings";
const key = (slug: string, name: Name) => `brain-graph.demo.${name}.${slug}`;
const local = (slug: string, name: Name): unknown => {
  try {
    const raw = localStorage.getItem(key(slug, name));
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
};
const keep = (slug: string, name: Name, value: unknown) => {
  try {
    localStorage.setItem(key(slug, name), JSON.stringify(value));
  } catch {
    /* no browser storage: the change lasts until the page is reloaded */
  }
};
const read = async (slug: string, name: Name): Promise<unknown> => {
  const mine = local(slug, name);
  if (mine !== undefined || name === "layout.prev") return mine ?? null;
  const r = await fetch(`data/${encodeURIComponent(slug)}/${name}.json`).catch(() => null);
  return r?.ok ? r.json() : null;
};

/** The same answers as server/api.ts, for the routes a visitor of the static site can use. */
async function staticFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input, "http://localhost");
  const slug = url.searchParams.get("vault") ?? "";
  const dir = `data/${encodeURIComponent(slug)}`;
  const method = init?.method ?? "GET";
  const body = () => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
  switch (url.pathname) {
    case "/api/vaults": {
      const r = await fetch("data/vaults.json");
      if (!r.ok) return json({ error: `HTTP ${r.status}` }, r.status);
      return json({ vaults: await r.json(), useTolaria: false, tolariaAvailable: false, configPath: "" });
    }
    case "/api/graph":
      return fetch(`${dir}/graph.json`);
    case "/api/note":
      return fetch(`${dir}/notes/${enc(url.searchParams.get("id") ?? "")}.json`);
    case "/api/settings":
      if (method === "PUT") keep(slug, "settings", { ...((await read(slug, "settings")) ?? {}), ...body() });
      return json(method === "PUT" ? { ok: true } : ((await read(slug, "settings")) ?? {}));
    case "/api/layout": {
      const current = (await read(slug, "layout")) as Layout | null;
      if (method === "DELETE") {
        keep(slug, "layout", null);
        return new Response(null, { status: 204 });
      }
      if (method === "PUT") {
        const saved: Layout = { savedAt: new Date().toISOString(), positions: body().positions as Layout["positions"] };
        // As on the server: the previous version is kept only when more than 1% of the notes moved.
        if (current) {
          const ids = Object.keys(current.positions ?? {});
          const moved = ids.filter((id) => {
            const [a, b] = [current.positions[id], saved.positions[id]];
            return !b || Math.hypot(a[0] - b[0], a[1] - b[1]) > 1;
          }).length;
          if (moved > ids.length * 0.01) keep(slug, "layout.prev", current);
        }
        keep(slug, "layout", saved);
        return json({ savedAt: saved.savedAt, count: Object.keys(saved.positions).length, hasPrevious: !!(await read(slug, "layout.prev")) });
      }
      return current ? json({ ...current, hasPrevious: !!(await read(slug, "layout.prev")) }) : json({}, 404);
    }
    case "/api/layout/restore": {
      const [current, previous] = [await read(slug, "layout"), await read(slug, "layout.prev")];
      if (!previous) return json({ error: "no previous layout" }, 404);
      keep(slug, "layout", previous);
      if (current) keep(slug, "layout.prev", current);
      return json(previous);
    }
  }
  return json({ error: "not available in the static demo" }, 404);
}
