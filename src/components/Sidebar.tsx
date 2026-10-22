import { useEffect, useRef, useState } from "react";
import type { NoteNode, TypeInfo, VaultGraph } from "../types";
import { edgeStyle } from "../graph/colors";
import type { ColorMode } from "../graph/build";
import { TYPE_SHAPES, type HomeIndex, type HomeLevel, type HomeSettings, type Hub } from "../graph/home";

const SHAPE_GLYPH: Record<string, string> = { diamond: "◆", square: "■", triangle: "▲", circle: "●" };
const glyphFor = (type: string) => SHAPE_GLYPH[TYPE_SHAPES[type] ?? "circle"];

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
  /** Show every note's label (density-managed) instead of only hovered / selected ones. */
  labels: boolean;
  /** Highlight every note of a type or of a home group and fade the rest (nothing is hidden). */
  spotlight: { kind: "type"; value: string } | { kind: "hub"; id: string } | null;
}

interface Props {
  data: VaultGraph;
  types: TypeInfo[];
  typeColors: Map<string, string>;
  homeIndex: HomeIndex;
  homeSettings: HomeSettings;
  /** Default hub types for this vault (depends on its ontology). */
  homeDefaults: string[];
  onHomeSettings: (s: HomeSettings) => void;
  colorMode: ColorMode;
  homeLevel: HomeLevel;
  onColorMode: (mode: ColorMode, level: HomeLevel) => void;
  edgeKinds: { kind: string; count: number }[];
  filters: Filters;
  onChange: (f: Filters) => void;
  selected: string | null;
  onSelect: (id: string) => void;
}

const LEVEL_LABELS = ["Top-level groups", "Second level", "Nearest group"];

export function Sidebar(p: Props) {
  const { data, types, typeColors, homeIndex, homeSettings, homeDefaults, colorMode, homeLevel, edgeKinds, filters, onChange, selected, onSelect } = p;
  const [showGrouping, setShowGrouping] = useState(false);
  const asideRef = useRef<HTMLElement>(null);

  // When a hub is selected on the graph, reveal and scroll to its row.
  useEffect(() => {
    if (!selected || !homeIndex.hubs.has(selected)) return;
    setOpenHubs((open) => {
      const next = new Set(open);
      let p = homeIndex.hubs.get(selected)?.parent ?? null;
      while (p) {
        next.add(p);
        p = homeIndex.hubs.get(p)?.parent ?? null;
      }
      return next;
    });
    const t = setTimeout(() => asideRef.current?.querySelector(`[data-hub="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: "nearest" }), 50);
    return () => clearTimeout(t);
  }, [selected, homeIndex]);
  const [openTypes, setOpenTypes] = useState<Set<string>>(new Set());
  const [openHubs, setOpenHubs] = useState<Set<string>>(() => new Set(homeIndex.roots.slice(0, 3)));
  const toggleHubType = (type: string) => {
    const next = new Set(homeSettings.hubTypes);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    if (next.size) p.onHomeSettings({ ...homeSettings, hubTypes: next });
  };
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
  const spotHub = (id: string) => onChange({ ...filters, spotlight: filters.spotlight?.kind === "hub" && filters.spotlight.id === id ? null : { kind: "hub", id } });
  const spotType = (value: string) => onChange({ ...filters, spotlight: filters.spotlight?.kind === "type" && filters.spotlight.value === value ? null : { kind: "type", value } });
  const hubSpot = (id: string) => filters.spotlight?.kind === "hub" && filters.spotlight.id === id;
  const typeSpot = (value: string) => filters.spotlight?.kind === "type" && filters.spotlight.value === value;

  const instancesOf = (type: string): NoteNode[] =>
    data.nodes.filter((n) => (n.type ?? "(untyped)") === type).sort((a, b) => b.inDegree + b.outDegree - (a.inDegree + a.outDegree) || a.title.localeCompare(b.title));

  const renderHub = (id: string): React.ReactNode => {
    const hub: Hub | undefined = homeIndex.hubs.get(id);
    if (!hub) return null;
    const open = openHubs.has(id);
    const isolated = filters.subtree === id;
    return (
      <li key={id} className={`tree-row${isolated ? " isolated" : ""}${selected === id ? " selected" : ""}${hubSpot(id) ? " spotlit" : ""}`} data-hub={id}>
        <div className="tree-line" style={{ paddingLeft: hub.depth * 12 }}>
          <button className={`disclosure${hub.children.length ? "" : " empty"}`} onClick={() => setOpenHubs(toggleIn(openHubs, id))} aria-label={open ? "Collapse" : "Expand"}>
            {hub.children.length ? (open ? "▾" : "▸") : ""}
          </button>
          <button className="tree-label" onClick={(e) => (e.altKey ? isolate(id) : onSelect(id))} title={`${hub.type} · ${hub.subtreeCount} notes in subtree · Alt-click to isolate`}>
            {colorMode === "home" ? (
              <span className="swatch" style={{ background: homeIndex.palettes[homeLevel].get(id), borderRadius: hub.type === "Project" ? 2 : "50%" }} />
            ) : (
              <span className="glyph muted">{glyphFor(hub.type)}</span>
            )}
            <span className="name">{hub.title}</span>
            <span className="count">{hub.subtreeCount}</span>
          </button>
          <button className={`iso${hubSpot(id) ? " on" : ""}`} onClick={() => spotHub(id)} title={hubSpot(id) ? "Stop highlighting this group" : "Highlight every note of this group and fade the rest"}>
            {hubSpot(id) ? "unfocus" : "focus"}
          </button>
          <button className={`iso${isolated ? " on" : ""}`} onClick={() => isolate(id)} title={isolated ? "Show all notes again" : "Hide every note outside this group (the view does not move)"}>
            {isolated ? "all" : "only"}
          </button>
        </div>
        {open && hub.children.length > 0 && <ul className="tree">{hub.children.map(renderHub)}</ul>}
      </li>
    );
  };

  return (
    <aside className="sidebar" ref={asideRef}>
      <section className={colorMode === "home" ? "colour-source" : ""}>
        <header>
          <h2>Home</h2>
          <span className="header-tools">
            {filters.subtree && (
              <button className="link small" onClick={() => onChange({ ...filters, subtree: null })}>
                show all
              </button>
            )}
            <button className={`pill-toggle${colorMode === "home" ? " on" : ""}`} onClick={() => p.onColorMode("home", homeLevel)} title="Colour the graph by home group">
              {colorMode === "home" ? "● colouring" : "colour by this"}
            </button>
          </span>
        </header>
        {colorMode === "home" && (
          <label className="row column">
            <span>
              Roll up to: <strong>{LEVEL_LABELS[homeLevel]}</strong>
            </span>
            <input type="range" min={0} max={2} value={homeLevel} onChange={(e) => p.onColorMode("home", Number(e.target.value) as HomeLevel)} />
          </label>
        )}
        {(() => {
          const isDefault = homeSettings.useHas && homeSettings.hubTypes.size === homeDefaults.length && homeDefaults.every((t) => homeSettings.hubTypes.has(t));
          return (
            <div className="grouping-line">
              <button className="link small grouping-toggle" onClick={() => setShowGrouping((v) => !v)}>
                {showGrouping ? "▾" : "▸"} grouping: {[...homeSettings.hubTypes].join(", ")}
                {homeSettings.useHas ? "" : " · belongs_to only"}
                {isDefault ? " (default)" : ""}
              </button>
              {!isDefault && (
                <button className="link small" onClick={() => p.onHomeSettings({ hubTypes: new Set(homeDefaults), useHas: true })} title={`Back to ${homeDefaults.join(", ")} with the has fallback`}>
                  reset
                </button>
              )}
            </div>
          );
        })()}
        {showGrouping && (
          <div className="grouping">
            <div className="muted small">
              Types that act as groups. A note joins the nearest one reached through its <code>belongs_to</code> (or <code>parent_*</code>) chain. Default for this vault: {homeDefaults.join(", ")}.
            </div>
            <div className="chips">
              {types
                .filter((t) => t.name !== "Type" && t.name !== "(untyped)")
                .map((t) => (
                  <button key={t.name} className={`chip${homeSettings.hubTypes.has(t.name) ? " on" : ""}`} onClick={() => toggleHubType(t.name)}>
                    {t.name}
                  </button>
                ))}
            </div>
            <label className="row" title="Tolaria treats `has` as the inverse of `belongs_to`. This vault uses it for selective entry points, so it is only followed when belongs_to reaches no group.">
              <input type="checkbox" checked={homeSettings.useHas} onChange={(e) => p.onHomeSettings({ ...homeSettings, useHas: e.target.checked })} />
              Fall back to <code>has</code> links
            </label>
          </div>
        )}
        <ul className="tree">{homeIndex.roots.map(renderHub)}</ul>
      </section>

      <section className={colorMode === "type" ? "colour-source" : ""}>
        <header>
          <h2>Types</h2>
          <span className="header-tools">
            {filters.spotlight?.kind === "type" && (
              <button className="link small" onClick={() => onChange({ ...filters, spotlight: null })}>
                unfocus
              </button>
            )}
            <span className="muted small">
              <button className="link" onClick={() => setAll("types", true)}>all</button> ·{" "}
              <button className="link" onClick={() => setAll("types", false)}>none</button>
            </span>
            <button className={`pill-toggle${colorMode === "type" ? " on" : ""}`} onClick={() => p.onColorMode("type", homeLevel)} title="Colour the graph by note type">
              {colorMode === "type" ? "● colouring" : "colour by this"}
            </button>
          </span>
        </header>
        {colorMode === "home" && <div className="muted small hint">Shapes while colouring by home: ◆ project · ■ responsibility/topic · ▲ question · ● other</div>}
        <ul className="legend">
          {types.map((t) => {
            const on = filters.types.has(t.name);
            const open = openTypes.has(t.name);
            const items = open ? instancesOf(t.name) : [];
            const limit = showAll.has(t.name) ? items.length : 40;
            return (
              <li key={t.name} className={`${on ? "" : "off"}${typeSpot(t.name) ? " spotlit" : ""}`}>
                <div className="tree-line">
                  <button className="disclosure" onClick={() => setOpenTypes(toggleIn(openTypes, t.name))} aria-label={open ? "Collapse" : "Expand"}>
                    {open ? "▾" : "▸"}
                  </button>
                  <button className="tree-label" onClick={(e) => toggle("types", t.name, e.altKey)} title="Click to show/hide, Alt-click to isolate this type">
                    {colorMode === "type" ? <span className="swatch" style={{ background: typeColors.get(t.name) }} /> : <span className="glyph muted">{glyphFor(t.name)}</span>}
                    <span className="name">{t.name}</span>
                    <span className="count">{t.count}</span>
                  </button>
                  <button className={`iso${typeSpot(t.name) ? " on" : ""}`} onClick={() => spotType(t.name)} title={typeSpot(t.name) ? "Stop highlighting this type" : "Highlight every note of this type and fade the rest"}>
                    {typeSpot(t.name) ? "unfocus" : "focus"}
                  </button>
                  {(() => {
                    const onlyThis = filters.types.size === 1 && filters.types.has(t.name);
                    return (
                      <button className={`iso${onlyThis ? " on" : ""}`} onClick={() => toggle("types", t.name, true)} title={onlyThis ? "Show all types again" : "Hide every other type (the view does not move)"}>
                        {onlyThis ? "all" : "only"}
                      </button>
                    );
                  })()}
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
        <label className="row" title="Labels are otherwise shown only for hovered or selected notes and their neighbours.">
          <input type="checkbox" checked={filters.labels} onChange={(e) => onChange({ ...filters, labels: e.target.checked })} />
          Show all note labels
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
