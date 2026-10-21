import { useState } from "react";
import type { NoteNode, TypeInfo, VaultGraph } from "../types";
import { edgeStyle } from "../graph/colors";
import type { ColorMode } from "../graph/build";
import type { HomeIndex, HomeLevel, Hub } from "../graph/home";

export interface Filters {
  types: Set<string>; // visible types
  kinds: Set<string>; // visible edge kinds
  hideArchived: boolean;
  hideOrphans: boolean;
  focusDepth: number; // 0 = whole graph
  /** Isolate the notes under this hub (project / responsibility / topic). */
  subtree: string | null;
  /** Hide Source notes and show their count on the parent note's label. */
  collapseSources: boolean;
  /** Fade notes by time since last edit. */
  recency: boolean;
  /** Tinted hull and name behind each home group. */
  hulls: boolean;
}

interface Props {
  data: VaultGraph;
  types: TypeInfo[];
  typeColors: Map<string, string>;
  homeIndex: HomeIndex;
  colorMode: ColorMode;
  homeLevel: HomeLevel;
  onColorMode: (mode: ColorMode, level: HomeLevel) => void;
  edgeKinds: { kind: string; count: number }[];
  filters: Filters;
  onChange: (f: Filters) => void;
  selected: string | null;
  onSelect: (id: string) => void;
}

const LEVEL_LABELS = ["Area", "Project", "Subproject"];

export function Sidebar(p: Props) {
  const { data, types, typeColors, homeIndex, colorMode, homeLevel, edgeKinds, filters, onChange, selected, onSelect } = p;
  const [openTypes, setOpenTypes] = useState<Set<string>>(new Set());
  const [openHubs, setOpenHubs] = useState<Set<string>>(() => new Set(homeIndex.roots.slice(0, 3)));
  const [showAll, setShowAll] = useState<Set<string>>(new Set());

  const toggleIn = (set: Set<string>, value: string) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };
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
  const isolate = (id: string) => onChange({ ...filters, subtree: filters.subtree === id ? null : id });

  const instancesOf = (type: string): NoteNode[] =>
    data.nodes.filter((n) => (n.type ?? "(untyped)") === type).sort((a, b) => b.inDegree + b.outDegree - (a.inDegree + a.outDegree) || a.title.localeCompare(b.title));

  const renderHub = (id: string): React.ReactNode => {
    const hub: Hub | undefined = homeIndex.hubs.get(id);
    if (!hub) return null;
    const open = openHubs.has(id);
    const isolated = filters.subtree === id;
    return (
      <li key={id} className={`tree-row${isolated ? " isolated" : ""}${selected === id ? " selected" : ""}`}>
        <div className="tree-line" style={{ paddingLeft: hub.depth * 12 }}>
          <button className={`disclosure${hub.children.length ? "" : " empty"}`} onClick={() => setOpenHubs(toggleIn(openHubs, id))} aria-label={open ? "Collapse" : "Expand"}>
            {hub.children.length ? (open ? "▾" : "▸") : ""}
          </button>
          <button className="tree-label" onClick={(e) => (e.altKey ? isolate(id) : onSelect(id))} title={`${hub.type} · ${hub.subtreeCount} notes in subtree · Alt-click to isolate`}>
            <span className="swatch" style={{ background: homeIndex.palettes[homeLevel].get(id), borderRadius: hub.type === "Project" ? 2 : "50%" }} />
            <span className="name">{hub.title}</span>
            <span className="count">{hub.subtreeCount}</span>
          </button>
          <button className={`iso${isolated ? " on" : ""}`} onClick={() => isolate(id)} title={isolated ? "Show everything again" : "Show only this subtree"}>
            ◎
          </button>
        </div>
        {open && hub.children.length > 0 && <ul className="tree">{hub.children.map(renderHub)}</ul>}
      </li>
    );
  };

  return (
    <aside className="sidebar">
      <section>
        <header>
          <h2>Colour by</h2>
        </header>
        <div className="segmented">
          <button className={colorMode === "home" ? "on" : ""} onClick={() => p.onColorMode("home", homeLevel)}>Home</button>
          <button className={colorMode === "type" ? "on" : ""} onClick={() => p.onColorMode("type", homeLevel)}>Type</button>
        </div>
        {colorMode === "home" && (
          <label className="row column">
            <span>
              Roll up to: <strong>{LEVEL_LABELS[homeLevel]}</strong>
            </span>
            <input type="range" min={0} max={2} value={homeLevel} onChange={(e) => p.onColorMode("home", Number(e.target.value) as HomeLevel)} />
            <span className="muted small">Shapes: ◆ project · ■ responsibility/topic · ▲ question · ● other</span>
          </label>
        )}
      </section>

      <section>
        <header>
          <h2>Home</h2>
          {filters.subtree && (
            <button className="link small" onClick={() => onChange({ ...filters, subtree: null })}>
              show all
            </button>
          )}
        </header>
        <ul className="tree">{homeIndex.roots.map(renderHub)}</ul>
      </section>

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
            const open = openTypes.has(t.name);
            const items = open ? instancesOf(t.name) : [];
            const limit = showAll.has(t.name) ? items.length : 40;
            return (
              <li key={t.name} className={on ? "" : "off"}>
                <div className="tree-line">
                  <button className="disclosure" onClick={() => setOpenTypes(toggleIn(openTypes, t.name))} aria-label={open ? "Collapse" : "Expand"}>
                    {open ? "▾" : "▸"}
                  </button>
                  <button className="tree-label" onClick={(e) => toggle("types", t.name, e.altKey)} title="Click to show/hide, Alt-click to isolate this type">
                    <span className="swatch" style={{ background: typeColors.get(t.name) }} />
                    <span className="name">{t.name}</span>
                    <span className="count">{t.count}</span>
                  </button>
                </div>
                {open && (
                  <ul className="instances">
                    {items.slice(0, limit).map((n) => (
                      <li key={n.id} className={selected === n.id ? "selected" : ""}>
                        <button className="tree-label" onClick={() => onSelect(n.id)} title={n.summary}>
                          <span className="name">{n.title}</span>
                          <span className="count">{n.inDegree + n.outDegree}</span>
                        </button>
                      </li>
                    ))}
                    {items.length > limit && (
                      <li>
                        <button className="link small" onClick={() => setShowAll(toggleIn(showAll, t.name))}>
                          show all {items.length}
                        </button>
                      </li>
                    )}
                  </ul>
                )}
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
                <button className="tree-label" onClick={(e) => toggle("kinds", k.kind, e.altKey)}>
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
        <label className="row" title="Draw a tinted region with the group's name behind each home group at the current roll-up level.">
          <input type="checkbox" checked={filters.hulls} onChange={(e) => onChange({ ...filters, hulls: e.target.checked })} />
          Show group hulls
        </label>
        <label className="row" title="Sources are 44% of the notes and almost all leaves. Fold them into a +N count on the note they belong to.">
          <input type="checkbox" checked={filters.collapseSources} onChange={(e) => onChange({ ...filters, collapseSources: e.target.checked })} />
          Collapse Sources into their parent
        </label>
        <label className="row" title="Full colour: edited in the last 7 days. Faded: 30 days. Ghost: older than 90 days.">
          <input type="checkbox" checked={filters.recency} onChange={(e) => onChange({ ...filters, recency: e.target.checked })} />
          Fade notes not edited recently
        </label>
        <label className="row column">
          <span>
            Focus depth around selection: <strong>{filters.focusDepth === 0 ? "off" : filters.focusDepth}</strong>
            {!selected && filters.focusDepth > 0 && <span className="muted"> (select a note)</span>}
          </span>
          <input type="range" min={0} max={4} value={filters.focusDepth} onChange={(e) => onChange({ ...filters, focusDepth: Number(e.target.value) })} />
        </label>
      </section>
    </aside>
  );
}
