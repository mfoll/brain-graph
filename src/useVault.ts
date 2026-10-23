import { useEffect, useState } from "react";
import type { VaultGraph, VaultInfo } from "./types";
import type { Positions } from "./graph/build";
import { loadSettings } from "./settingsStore";

export interface SavedLayout {
  savedAt: string;
  positions: Positions;
  /** The server keeps the previous version of the file; it can be restored. */
  hasPrevious?: boolean;
}

const q = (slug: string | null) => (slug ? `vault=${encodeURIComponent(slug)}` : "");

export interface VaultRegistry {
  vaults: VaultInfo[];
  useTolaria: boolean;
  tolariaAvailable: boolean;
  configPath: string;
}

/** Vaults the server can serve: folders added by hand, Tolaria's registry when imported, the VAULT env vault. */
export function useVaults() {
  const [registry, setRegistry] = useState<VaultRegistry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apply = async (r: Response) => {
    const body = (await r.json()) as VaultRegistry & { error?: string };
    if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
    setRegistry(body);
  };
  useEffect(() => {
    fetch("/api/vaults")
      .then(apply)
      .catch((e) => setError(String(e)));
  }, []);
  const addVault = (path: string, label?: string) => fetch("/api/vaults", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, label }) }).then(apply);
  const removeVault = (path: string) => fetch(`/api/vaults?path=${encodeURIComponent(path)}`, { method: "DELETE" }).then(apply);
  const setUseTolaria = (useTolaria: boolean) => fetch("/api/vaults", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ useTolaria }) }).then(apply);
  return { vaults: registry?.vaults ?? null, registry, error, addVault, removeVault, setUseTolaria };
}

export function useVault(slug: string | null) {
  const [data, setData] = useState<VaultGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setData(null);
    // Settings load with the graph, so the first render already uses them.
    Promise.all([fetch(`/api/graph?${q(slug)}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))), loadSettings(slug)])
      .then(([g]: [VaultGraph, void]) => !cancelled && setData(g))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [slug, version]);

  useEffect(() => {
    if (!slug) return;
    const es = new EventSource(`/api/events?${q(slug)}`);
    es.addEventListener("changed", () => setVersion((v) => v + 1));
    return () => es.close();
  }, [slug]);

  return { data, error, reload: () => setVersion((v) => v + 1) };
}

/** Saved node positions for one vault, stored by the dev server in a per-vault sidecar file. */
export function useSavedLayout(slug: string | null) {
  // The layout is stored together with the slug it belongs to, so a vault switch never exposes the
  // previous vault's positions for even one render (that race used to seed the new graph wrongly).
  const [state, setState] = useState<{ slug: string | null; layout: SavedLayout | null | undefined }>({ slug: null, layout: undefined });
  const layout = state.slug === slug ? state.layout : undefined; // undefined = loading

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    fetch(`/api/layout?${q(slug)}`)
      .then((r) => (r.ok ? (r.json() as Promise<SavedLayout>) : null))
      .then((l) => !cancelled && setState({ slug, layout: l }))
      .catch(() => !cancelled && setState({ slug, layout: null }));
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const save = async (positions: Positions) => {
    const r = await fetch(`/api/layout?${q(slug)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ positions }) });
    if (r.ok) {
      const { savedAt, hasPrevious } = (await r.json()) as { savedAt: string; hasPrevious?: boolean };
      setState({ slug, layout: { savedAt, positions, hasPrevious } });
    }
  };
  const reset = async () => {
    await fetch(`/api/layout?${q(slug)}`, { method: "DELETE" });
    setState({ slug, layout: null });
  };

  return { layout, save, reset };
}
