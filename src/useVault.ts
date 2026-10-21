import { useEffect, useState } from "react";
import type { VaultGraph, VaultInfo } from "./types";
import type { Positions } from "./graph/build";

export interface SavedLayout {
  savedAt: string;
  positions: Positions;
}

const q = (slug: string | null) => (slug ? `vault=${encodeURIComponent(slug)}` : "");

/** Vaults the server can serve (Tolaria's registry plus the VAULT env vault). */
export function useVaults() {
  const [vaults, setVaults] = useState<VaultInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/vaults")
      .then((r) => (r.ok ? (r.json() as Promise<VaultInfo[]>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setVaults)
      .catch((e) => setError(String(e)));
  }, []);
  return { vaults, error };
}

export function useVault(slug: string | null) {
  const [data, setData] = useState<VaultGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setData(null);
    fetch(`/api/graph?${q(slug)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((g: VaultGraph) => !cancelled && setData(g))
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
  const [layout, setLayout] = useState<SavedLayout | null | undefined>(undefined); // undefined = loading

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setLayout(undefined);
    fetch(`/api/layout?${q(slug)}`)
      .then((r) => (r.ok ? (r.json() as Promise<SavedLayout>) : null))
      .then((l) => !cancelled && setLayout(l))
      .catch(() => !cancelled && setLayout(null));
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const save = async (positions: Positions) => {
    const r = await fetch(`/api/layout?${q(slug)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ positions }) });
    if (r.ok) {
      const { savedAt } = (await r.json()) as { savedAt: string };
      setLayout({ savedAt, positions });
    }
  };
  const reset = async () => {
    await fetch(`/api/layout?${q(slug)}`, { method: "DELETE" });
    setLayout(null);
  };

  return { layout, save, reset };
}
