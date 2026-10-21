import { useEffect, useState } from "react";
import type { VaultGraph } from "./types";

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
