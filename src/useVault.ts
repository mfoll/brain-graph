import { useEffect, useState } from "react";
import type { VaultGraph } from "./types";
import type { Positions } from "./graph/build";

export interface SavedLayout {
  savedAt: string;
  positions: Positions;
}

export function useVault() {
  const [data, setData] = useState<VaultGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/graph")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((g: VaultGraph) => !cancelled && setData(g))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [version]);

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("changed", () => setVersion((v) => v + 1));
    return () => es.close();
  }, []);

  return { data, error, reload: () => setVersion((v) => v + 1) };
}

/** Saved node positions, stored by the dev server in a per-vault sidecar file. */
export function useSavedLayout() {
  const [layout, setLayout] = useState<SavedLayout | null | undefined>(undefined); // undefined = loading

  useEffect(() => {
    let cancelled = false;
    fetch("/api/layout")
      .then((r) => (r.ok ? (r.json() as Promise<SavedLayout>) : null))
      .then((l) => !cancelled && setLayout(l))
      .catch(() => !cancelled && setLayout(null));
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (positions: Positions) => {
    const r = await fetch("/api/layout", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ positions }) });
    if (r.ok) {
      const { savedAt } = (await r.json()) as { savedAt: string };
      setLayout({ savedAt, positions });
    }
  };
  const reset = async () => {
    await fetch("/api/layout", { method: "DELETE" });
    setLayout(null);
  };

  return { layout, save, reset };
}
