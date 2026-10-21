import type { TypeInfo } from "../types";
import { edgeStyle } from "../graph/colors";

export interface Filters {
  types: Set<string>; // visible types
  kinds: Set<string>; // visible edge kinds
  hideArchived: boolean;
  hideOrphans: boolean;
  focusDepth: number; // 0 = whole graph
}

interface Props {
  types: TypeInfo[];
  typeColors: Map<string, string>;
  edgeKinds: { kind: string; count: number }[];
  filters: Filters;
  onChange: (f: Filters) => void;
  hasSelection: boolean;
}

export function Sidebar({ types, typeColors, edgeKinds, filters, onChange, hasSelection }: Props) {
  const toggle = <K extends "types" | "kinds">(key: K, value: string, only: boolean) => {
    const next = new Set(filters[key]);
    if (only) {
      const all = key === "types" ? types.map((t) => t.name) : edgeKinds.map((k) => k.kind);
      const isOnly = next.size === 1 && next.has(value);
      next.clear();
      if (isOnly) all.forEach((v) => next.add(v));
      else next.add(value);
    } else if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange({ ...filters, [key]: next });
  };
  const setAll = (key: "types" | "kinds", on: boolean) => {
    const all = key === "types" ? types.map((t) => t.name) : edgeKinds.map((k) => k.kind);
    onChange({ ...filters, [key]: new Set(on ? all : []) });
  };

  return (
    <aside className="sidebar">
      <section>
        <header>
          <h2>Types</h2>
          <span className="muted small">
            <button className="link" onClick={() => setAll("types", true)}>all</button> ·{" "}
            <button className="link" onClick={() => setAll("types", false)}>none</button>
          </span>
        </header>
        <ul className="legend">
          {types.map((t) => {
            const on = filters.types.has(t.name);
            return (
              <li key={t.name} className={on ? "" : "off"} title="Click to toggle, Alt-click to isolate">
                <button onClick={(e) => toggle("types", t.name, e.altKey)}>
                  <span className="swatch" style={{ background: typeColors.get(t.name) }} />
                  <span className="name">{t.name}</span>
                  <span className="count">{t.count}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <header>
          <h2>Relationships</h2>
          <span className="muted small">
            <button className="link" onClick={() => setAll("kinds", true)}>all</button> ·{" "}
            <button className="link" onClick={() => setAll("kinds", false)}>none</button>
          </span>
        </header>
        <ul className="legend">
          {edgeKinds.map((k) => {
            const on = filters.kinds.has(k.kind);
            const st = edgeStyle(k.kind);
            return (
              <li key={k.kind} className={on ? "" : "off"} title="Click to toggle, Alt-click to isolate">
                <button onClick={(e) => toggle("kinds", k.kind, e.altKey)}>
                  <span className="edge-swatch" style={{ background: st.color, height: Math.max(1, st.width) }} />
                  <span className="name">
                    {k.kind}
                    {st.directed ? " →" : ""}
                  </span>
                  <span className="count">{k.count}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <header>
          <h2>Options</h2>
        </header>
        <label className="row">
          <input type="checkbox" checked={filters.hideArchived} onChange={(e) => onChange({ ...filters, hideArchived: e.target.checked })} />
          Hide archived notes
        </label>
        <label className="row">
          <input type="checkbox" checked={filters.hideOrphans} onChange={(e) => onChange({ ...filters, hideOrphans: e.target.checked })} />
          Hide orphans (no visible links)
        </label>
        <label className="row column">
          <span>
            Focus depth around selection: <strong>{filters.focusDepth === 0 ? "off" : filters.focusDepth}</strong>
            {!hasSelection && filters.focusDepth > 0 && <span className="muted"> (select a note)</span>}
          </span>
          <input type="range" min={0} max={4} value={filters.focusDepth} onChange={(e) => onChange({ ...filters, focusDepth: Number(e.target.value) })} />
        </label>
      </section>
    </aside>
  );
}
