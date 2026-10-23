// Per-vault settings (grouping, view filters, layout physics, saved views), kept by the local server in
// ~/.config/brain-graph/settings/<vault>.json so they do not depend on one browser. Loaded with the
// graph, read synchronously afterwards, written back shortly after each change.
type Key = "grouping" | "view" | "layout" | "views";
const KEYS: Key[] = ["grouping", "view", "layout", "views"];
const cache = new Map<string, Partial<Record<Key, unknown>>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const put = (slug: string) =>
  fetch(`/api/settings?vault=${encodeURIComponent(slug)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cache.get(slug) ?? {}) }).catch(() => undefined);

export async function loadSettings(slug: string): Promise<void> {
  const r = await fetch(`/api/settings?vault=${encodeURIComponent(slug)}`).catch(() => null);
  const stored = (r?.ok ? await r.json() : {}) as Partial<Record<Key, unknown>>;
  // One-time copy of settings that older versions kept in the browser.
  let migrated = false;
  for (const key of KEYS) {
    if (stored[key] !== undefined) continue;
    try {
      const raw = localStorage.getItem(`brain-graph.${key}.${slug}`);
      if (raw) {
        stored[key] = JSON.parse(raw);
        migrated = true;
      }
    } catch {
      /* no browser storage */
    }
  }
  cache.set(slug, stored);
  if (migrated) void put(slug);
}

export const getSetting = <T>(slug: string, key: Key): T | undefined => cache.get(slug)?.[key] as T | undefined;

export function setSetting(slug: string, key: Key, value: unknown): void {
  cache.set(slug, { ...cache.get(slug), [key]: value });
  clearTimeout(timers.get(slug));
  timers.set(slug, setTimeout(() => void put(slug), 300));
}
