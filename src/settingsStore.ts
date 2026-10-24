// Per-vault settings (grouping, view filters, layout physics, saved views), kept by the local server in
// ~/.config/brain-graph/settings/<vault>.json so they do not depend on one browser. Loaded with the
// graph, read synchronously afterwards, written back shortly after each change.
import { apiFetch } from "./staticSite";

type Key = "grouping" | "view" | "layout" | "views";
const KEYS: Key[] = ["grouping", "view", "layout", "views"];
const cache = new Map<string, Partial<Record<Key, unknown>>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

// Only the keys this tab changed are sent, and the server merges them into the file, so another tab
// (or an idle one reacting to a vault change) never overwrites settings it did not touch.
const dirty = new Map<string, Set<Key>>();
const put = (slug: string, keys: Iterable<Key> = dirty.get(slug) ?? []) => {
  const all = cache.get(slug) ?? {};
  const body = Object.fromEntries([...keys].map((k) => [k, all[k]]));
  dirty.delete(slug);
  return apiFetch(`/api/settings?vault=${encodeURIComponent(slug)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
};

export async function loadSettings(slug: string): Promise<void> {
  const r = await apiFetch(`/api/settings?vault=${encodeURIComponent(slug)}`).catch(() => null);
  const stored = (r?.ok ? await r.json() : {}) as Partial<Record<Key, unknown>>;
  // One-time copy of settings that older versions kept in the browser.
  const migrated: Key[] = [];
  for (const key of KEYS) {
    if (stored[key] !== undefined) continue;
    try {
      const raw = localStorage.getItem(`brain-graph.${key}.${slug}`);
      if (raw) {
        stored[key] = JSON.parse(raw);
        migrated.push(key);
      }
    } catch {
      /* no browser storage */
    }
  }
  cache.set(slug, stored);
  if (migrated.length) void put(slug, migrated);
}

export const getSetting = <T>(slug: string, key: Key): T | undefined => cache.get(slug)?.[key] as T | undefined;

export function setSetting(slug: string, key: Key, value: unknown): void {
  if (JSON.stringify(cache.get(slug)?.[key]) === JSON.stringify(value)) return;
  cache.set(slug, { ...cache.get(slug), [key]: value });
  (dirty.get(slug) ?? dirty.set(slug, new Set()).get(slug)!).add(key);
  clearTimeout(timers.get(slug));
  timers.set(slug, setTimeout(() => void put(slug), 300));
}
