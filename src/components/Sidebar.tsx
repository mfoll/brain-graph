import { useEffect, useRef, useState } from "react";
import type { NoteNode, TypeInfo, VaultGraph } from "../types";
import { edgeStyle } from "../graph/colors";
import { SHAPE_GLYPH, shapeFor, type HomeIndex, type HomeLevel, type HomeSettings, type Hub } from "../graph/home";
import { DEFAULT_LAYOUT, type LayoutSettings } from "../graph/build";

export interface Filters {
  types: Set<string>; // visible types
  kinds: Set<string>; // visible edge kinds
  hideArchived: boolean;
  hideOrphans: boolean;
  focusDepth: number; // 0 = whole graph
  /** Hide Source notes and show their count on the parent note's label. */
  collapseSources: boolean;
  /** Fade notes by time since last edit. */
  recency: boolean;
  /** Tinted hull and name behind each home group. */
  hulls: boolean;
  /** Show every note's label (density-managed) instead of only hovered / selected ones. */
  labels: boolean;
  /** Highlight every note of a type or of a home group and fade the rest (nothing is hidden). */
  spotlight: { kind: "type"; value: string } | { kind: "hub"; id: string } | { kind: "facet"; type: string; key: string; value: string } | { kind: "unassigned" } | null;
  /** Hide notes with fewer visible links than this (group notes are always kept). 0 = off. */
  minDegree: number;
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
  homeLevel: HomeLevel;
  onHomeLevel: (level: HomeLevel) => void;
  edgeKinds: { kind: string; count: number }[];
  filters: Filters;
  onChange: (f: Filters) => void;
  selected: string | null;
  onSelect: (id: string) => void;
  /** Click on a Home row: focus the group (and select its note), or unfocus when already focused. */
  onFocusHub: (id: string) => void;
  /** Notes that reach no group at all. */
  unassignedCount: number;
  layoutSettings: LayoutSettings;
  onLayoutSettings: (s: LayoutSettings) => void;
  layoutRunning: boolean;
}

const LEVEL_LABELS = ["Top-level groups", "Second level", "Nearest group"];

export function Sidebar(p: Props) {
  const { data, types, homeIndex, homeSettings, homeDefaults, homeLevel, edgeKinds, filters, onChange, selected, onSelect, onFocusHub, unassignedCount, layoutSettings, onLayoutSettings } = p;
  const ls = layoutSettings;
  const layoutIsDefault = JSON.stringify(ls) === JSON.stringify(DEFAULT_LAYOUT);

  // Facets: scalar frontmatter keys shared by enough notes and with few distinct values (a status, a
  // kind, a period), not identifiers or URLs; `status` first when present.
  const facetKeys = (() => {
    const counts = new Map<string, number>();
    const values = new Map<string, Set<string>>();
    for (const n of data.nodes) {
      for (const [k, v] of Object.entries(n.properties)) {
        if (k === "type" || k.startsWith("_") || (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean")) continue;
        counts.set(k, (counts.get(k) ?? 0) + 1);
        (values.get(k) ?? values.set(k, new Set()).get(k)!).add(String(v));
      }
    }
    const min = Math.max(5, data.nodes.length * 0.05);
    const keys = [...counts.entries()]
      .filter(([k, c]) => c >= min && (values.get(k)?.size ?? 0) <= 25 && (values.get(k)?.size ?? 0) < c / 2)
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);
    if (keys.includes("status")) return ["status", ...keys.filter((k) => k !== "status")];
    return keys;
  })();
  const [facetKey, setFacetKey] = useState<string>(() => facetKeys[0] ?? "status");
  const facetsOf = (type: string): [string, number][] => {
    const counts = new Map<string, number>();
    for (const n of data.nodes) {
      if ((n.type ?? "(untyped)") !== type) continue;
      const v = n.properties[facetKey];
      if (v === undefined || v === null || v === "") continue;
      counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  };
  const facetSpot = (type: string, value: string) => filters.spotlight?.kind === "facet" && filters.spotlight.type === type && filters.spotlight.key === facetKey && filters.spotlight.value === value;
  const spotFacet = (type: string, value: string) => onChange({ ...filters, spotlight: facetSpot(type, value) ? null : { kind: "facet", type, key: facetKey, value } });
  const unassignedSpot = filters.spotlight?.kind === "unassigned";
  const glyphFor = (type: string) => SHAPE_GLYPH[shapeFor(type, homeSettings)];
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
  const toggle = <K extends "types" | "kinds">(key: K, value: string, only = false) => {
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
  const spotType = (value: string) => onChange({ ...filters, spotlight: filters.spotlight?.kind === "type" && filters.spotlight.value === value ? null : { kind: "type", value } });
  const hubSpot = (id: string) => filters.spotlight?.kind === "hub" && filters.spotlight.id === id;
  const typeSpot = (value: string) => filters.spotlight?.kind === "type" && filters.spotlight.value === value;

  const instancesOf = (type: string): NoteNode[] =>
    data.nodes.filter((n) => (n.type ?? "(untyped)") === type).sort((a, b) => b.inDegree + b.outDegree - (a.inDegree + a.outDegree) || a.title.localeCompare(b.title));

  const renderHub = (id: string): React.ReactNode => {
    const hub: Hub | undefined = homeIndex.hubs.get(id);
    if (!hub) return null;
    const open = openHubs.has(id);
    return (
      <li key={id} className={`tree-row${selected === id ? " selected" : ""}${hubSpot(id) ? " spotlit" : ""}`} data-hub={id}>
        <div className="tree-line" style={{ paddingLeft: hub.depth * 12 }}>
          <button className={`disclosure${hub.children.length ? "" : " empty"}`} onClick={() => setOpenHubs(toggleIn(openHubs, id))} aria-label={open ? "Collapse" : "Expand"}>
            {hub.children.length ? (open ? "▾" : "▸") : ""}
          </button>
          <button className="tree-label" onClick={() => onFocusHub(id)} title={`${hub.type} · ${hub.subtreeCount} notes · click to focus this group and open its note, click again to unfocus`}>
            <span className="glyph" style={{ color: homeIndex.palettes[homeLevel].get(id) }} title={hub.type}>
              {glyphFor(hub.type)}
            </span>
            <span className="name">{hub.title}</span>
            <span className="count">{hub.subtreeCount}</span>
          </button>
        </div>
        {open && hub.children.length > 0 && <ul className="tree">{hub.children.map(renderHub)}</ul>}
      </li>
    );
  };

  return (
    <aside className="sidebar" ref={asideRef}>
      <section>
        <header>
          <h2>Home</h2>
          <span className="header-tools">
            {filters.spotlight?.kind === "hub" && (
              <button className="link small" onClick={() => onChange({ ...filters, spotlight: null })}>
                unfocus
              </button>
            )}
          </span>
        </header>
        <label className="row column" title="Colours follow the groups: pick how far up the hierarchy a note takes its colour from.">
          <span>
            Colour by group, rolled up to: <strong>{LEVEL_LABELS[homeLevel]}</strong>
          </span>
          <input type="range" min={0} max={2} value={homeLevel} onChange={(e) => p.onHomeLevel(Number(e.target.value) as HomeLevel)} />
        </label>
        <label className="row" title="Regions and names follow this section: the grouping types and the roll-up level above. A region is the union of a soft disc around each visible note of the group. Its name is shown when at least four of its notes are visible; names are placed largest group first and nudged up or down to avoid each other. Names fade while something is hovered or focused, and shrink while all note labels are shown.">
          <input type="checkbox" checked={filters.hulls} onChange={(e) => onChange({ ...filters, hulls: e.target.checked })} />
          Group regions and names
          <span className="muted small"> · follow the grouping and level above</span>
        </label>
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
              Types that act as groups, each drawn with its own shape in the order picked; other notes are circles. A note joins the nearest group reached through its <code>belongs_to</code> (or{" "}
              <code>parent_*</code>) chain. Default for this vault: {homeDefaults.join(", ")}.
            </div>
            <div className="chips">
              {types
                .filter((t) => t.name !== "Type" && t.name !== "(untyped)")
                .map((t) => (
                  <button key={t.name} className={`chip${homeSettings.hubTypes.has(t.name) ? " on" : ""}`} onClick={() => toggleHubType(t.name)} title={homeSettings.hubTypes.has(t.name) ? `Drawn as ${glyphFor(t.name)}` : "Make this type a group"}>
                    {homeSettings.hubTypes.has(t.name) ? `${glyphFor(t.name)} ` : ""}
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
        <ul className="tree">
          {homeIndex.roots.map(renderHub)}
          <li className={`tree-row unassigned${unassignedSpot ? " spotlit" : ""}`} title="Notes whose belongs_to chain reaches no group note. Click to focus them; the audit's target is zero.">
            <div className="tree-line">
              <button className="disclosure empty" aria-hidden="true" />
              <button className="tree-label" onClick={() => onChange({ ...filters, spotlight: unassignedSpot ? null : { kind: "unassigned" } })}>
                <span className="glyph muted">○</span>
                <span className="name muted">Unassigned</span>
                <span className="count">{unassignedCount}</span>
              </button>
            </div>
          </li>
        </ul>
      </section>

      <section>
        <header>
          <h2>Types</h2>
          <span className="header-tools">
            {(filters.spotlight?.kind === "type" || filters.spotlight?.kind === "facet") && (
              <button className="link small" onClick={() => onChange({ ...filters, spotlight: null })}>
                unfocus
              </button>
            )}
            {facetKeys.length > 1 && (
              <select className="facet-select" value={facetKey} onChange={(e) => setFacetKey(e.target.value)} title="Frontmatter key whose values are listed under each type">
                {facetKeys.map((k) => (
                  <option key={k} value={k}>
                    by {k}
                  </option>
                ))}
              </select>
            )}
            {types.some((t) => !filters.types.has(t.name)) && (
              <button className="link small" onClick={() => setAll("types", true)} title="Show every hidden type again">
                show all
              </button>
            )}
          </span>
        </header>
        <div className="muted small hint">
          Shapes: {[...homeSettings.hubTypes].map((t) => `${glyphFor(t)} ${t}`).join(" · ")} · ● other
        </div>
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
                  <button className="tree-label" onClick={() => spotType(t.name)} title={`${t.count} notes · click to focus this type, click again to unfocus`}>
                    <span className="glyph muted">{glyphFor(t.name)}</span>
                    <span className="name">{t.name}</span>
                    <span className="count">{t.count}</span>
                  </button>
                  <button className={`iso${on ? "" : " on"}`} onClick={() => toggle("types", t.name)} title={on ? "Hide this type from the graph" : "Show this type again"}>
                    {on ? "hide" : "hidden"}
                  </button>
                </div>
                {open && facetsOf(t.name).length > 0 && (
                  <div className="facets">
                    {facetsOf(t.name).map(([value, count]) => (
                      <button key={value} className={`chip${facetSpot(t.name, value) ? " on" : ""}`} onClick={() => spotFacet(t.name, value)} title={`Focus ${t.name} notes with ${facetKey} = ${value}`}>
                        {value} <span className="count">{count}</span>
                      </button>
                    ))}
                  </div>
                )}
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
              <li key={k.kind} className={on ? "" : "off"}>
                <button className="tree-label" onClick={(e) => toggle("kinds", k.kind, e.altKey)} title={on ? "Click to hide these links (Alt-click: show only this kind)" : "Click to show these links again"}>
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
          <h2>Layout physics</h2>
          <span className="header-tools">
            {!layoutIsDefault && (
              <button className="link small" onClick={() => onLayoutSettings(DEFAULT_LAYOUT)}>
                reset
              </button>
            )}
          </span>
        </header>
        <div className="muted small hint">Changes apply live in a short run. Groups form because hierarchy links pull harder than lateral ones; spread and gravity set how far everything sits apart.</div>
        <label className="row column" title="Repulsion between notes (ForceAtlas2 scalingRatio).">
          <span>
            Spread: <strong>{ls.spread}</strong>
          </span>
          <input type="range" min={2} max={40} step={1} value={ls.spread} onChange={(e) => onLayoutSettings({ ...ls, spread: Number(e.target.value) })} />
        </label>
        <label className="row column" title="Pull towards the centre (ForceAtlas2 gravity). Lower lets groups drift apart.">
          <span>
            Gravity: <strong>{ls.gravity}</strong>
          </span>
          <input type="range" min={0.1} max={3} step={0.1} value={ls.gravity} onChange={(e) => onLayoutSettings({ ...ls, gravity: Number(e.target.value) })} />
        </label>
        <label className="row column" title="How much harder belongs_to, has and parent_* links pull than a related_to link. Higher = tighter groups.">
          <span>
            Group pull: <strong>{ls.hierarchyWeight}×</strong>
          </span>
          <input type="range" min={1} max={10} step={0.5} value={ls.hierarchyWeight} onChange={(e) => onLayoutSettings({ ...ls, hierarchyWeight: Number(e.target.value) })} />
        </label>
        <label className="row" title="ForceAtlas2 LinLog mode: tighter groups with more space between them.">
          <input type="checkbox" checked={ls.separateGroups} onChange={(e) => onLayoutSettings({ ...ls, separateGroups: e.target.checked })} />
          Separate groups more (LinLog)
        </label>
        <label className="row" title="Notes stop overlapping; dense groups loosen up.">
          <input type="checkbox" checked={ls.preventOverlap} onChange={(e) => onLayoutSettings({ ...ls, preventOverlap: e.target.checked })} />
          Prevent overlap
        </label>
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
        <label className="row" title="Sources are 44% of the notes and almost all leaves. Fold them into a +N count on the note they belong to.">
          <input type="checkbox" checked={filters.collapseSources} onChange={(e) => onChange({ ...filters, collapseSources: e.target.checked })} />
          Collapse Sources into their parent
        </label>
        <label className="row" title="Full colour: edited in the last 7 days. Faded: 30 days. Ghost: older than 90 days.">
          <input type="checkbox" checked={filters.recency} onChange={(e) => onChange({ ...filters, recency: e.target.checked })} />
          Fade notes not edited recently
        </label>
        <label className="row column" title="Skeleton view: leaves and weakly connected notes disappear; group notes always stay.">
          <span>
            Hide notes with fewer than <strong>{filters.minDegree === 0 ? "— (off)" : filters.minDegree}</strong> visible links
          </span>
          <input type="range" min={0} max={5} value={filters.minDegree} onChange={(e) => onChange({ ...filters, minDegree: Number(e.target.value) })} />
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
