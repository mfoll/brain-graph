import { useEffect, useRef, useState } from "react";
import type { NoteNode, TypeInfo, VaultGraph } from "../types";
import { edgeStyle } from "../graph/colors";
import { DEFAULT_PALETTE, OUTSIDE_COLOR, defaultExemptTypes, PALETTES, SHAPE_GLYPH, defaultLinkRole, linkRole, shapeFor, type HomeIndex, type HomeLevel, type HomeSettings, type Hub, type LinkRole, type PaletteId } from "../graph/home";

const ROLE_LABEL: Record<LinkRole, string> = { up: "→ parent", down: "→ children", lateral: "lateral" };
const ROLE_GLYPH: Record<LinkRole, string> = { up: "↑", down: "↓", lateral: "↔" };
const NEXT_ROLE: Record<LinkRole, LinkRole> = { lateral: "up", up: "down", down: "lateral" };
import { DEFAULT_LAYOUT, groupColor, type LayoutSettings } from "../graph/build";

export interface Filters {
  types: Set<string>; // visible types
  kinds: Set<string>; // visible edge kinds
  hideArchived: boolean;
  hideOrphans: boolean;
  focusDepth: number; // 0 = whole graph
  /** Hide the notes of this type and show their count on the parent note's label (null = off). */
  collapseTypes: string[];
  /** Fade notes by time since last edit. */
  recency: boolean;
  /** Tinted region behind each home group. */
  hulls: boolean;
  /** Group names over the graph. */
  names: boolean;
  /** Show every note's label (density-managed) instead of only hovered / selected ones. */
  labels: boolean;
  /** Highlight every note of a type or of a home group and fade the rest (nothing is hidden). */
  spotlight: { kind: "type"; value: string } | { kind: "hub"; id: string } | { kind: "facet"; type: string; key: string; value: string } | { kind: "search"; query: string } | { kind: "unassigned" } | { kind: "outside" } | null;
  /** Show wikilink targets that resolve to no note, as grey ghost nodes. */
  ghosts: boolean;
  /** Show the notes of other registered vaults that this vault's frontmatter paths point to, as rectangles. */
  bridges: boolean;
  /** Pulse notes when an agent or another app reads or writes them. */
  activity: boolean;
  /** Hide notes with fewer visible links than this (group notes are always kept). 0 = off. */
  minDegree: number;
  /** Group region size multiplier. */
  regionSize: number;
  /** Base opacity of links. */
  linkOpacity: number;
  /** Link width multiplier. */
  linkWidth: number;
  /** Rendered node size (px) from which a note's label is drawn; lower shows more labels at a given zoom. */
  labelThreshold: number;
}

interface Props {
  data: VaultGraph;
  types: TypeInfo[];
  typeColors: Map<string, string>;
  homeIndex: HomeIndex;
  homeSettings: HomeSettings;
  /** Default hub types for the current vault (depends on its ontology). */
  homeDefaults: string[];
  /** Types ordered from most leaf-like (many notes, almost all with a single link) to least. */
  leafTypes: { type: string; count: number; leafShare: number }[];
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
  /** Notes outside the hierarchy by design (exempt types, archived and Inbox notes, parentless Persons). */
  outsideCount: number;
  layoutSettings: LayoutSettings;
  onLayoutSettings: (s: LayoutSettings) => void;
  layoutRunning: boolean;
  canRestoreLayout: boolean;
  onRestoreLayout: () => void;
  onResetLayout: () => void;
}


interface SectionProps {
  id: string;
  title: string;
  badge?: React.ReactNode;
  tools?: React.ReactNode;
  open: boolean;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}
function Section({ id, title, badge, tools, open, onToggle, children }: SectionProps) {
  return (
    <section className={open ? "" : "collapsed"}>
      <header>
        <button className="section-head" onClick={() => onToggle(id)} aria-expanded={open}>
          <span className="chev">{open ? "▾" : "▸"}</span>
          <h2>{title}</h2>
          {badge !== undefined && <span className="count">{badge}</span>}
        </button>
        {open && tools && <span className="header-tools">{tools}</span>}
      </header>
      {open && children}
    </section>
  );
}

const LEVEL_LABELS = ["Top-level groups", "Second level", "Nearest group"];

export function Sidebar(p: Props) {
  const { data, types, homeIndex, homeSettings, homeDefaults, leafTypes, homeLevel, edgeKinds, filters, onChange, selected, onSelect, onFocusHub, unassignedCount, outsideCount, layoutSettings, onLayoutSettings } = p;
  const ls = layoutSettings;
  const layoutIsDefault = ls.gravity === DEFAULT_LAYOUT.gravity && ls.ratio === DEFAULT_LAYOUT.ratio; // node size is a display setting

  // Facets: frontmatter keys worth listing under a type. `status` always comes first when present.
  // Other keys must be shared by several types (a key used by one family of notes is that family's
  // business), carried by enough notes, and have few distinct values (identifiers and dates excluded).
  const facetKeys = (() => {
    const counts = new Map<string, number>();
    const values = new Map<string, Set<string>>();
    const typesOf = new Map<string, Set<string>>();
    for (const n of data.nodes) {
      for (const [k, v] of Object.entries(n.properties)) {
        if (k === "type" || k.startsWith("_") || (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean")) continue;
        counts.set(k, (counts.get(k) ?? 0) + 1);
        (values.get(k) ?? values.set(k, new Set()).get(k)!).add(String(v));
        (typesOf.get(k) ?? typesOf.set(k, new Set()).get(k)!).add(n.type ?? "(untyped)");
      }
    }
    const keys = [...counts.entries()]
      .filter(([k, c]) => k !== "status" && c >= data.nodes.length * 0.1 && (typesOf.get(k)?.size ?? 0) >= 3 && (values.get(k)?.size ?? 0) <= 12)
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);
    return counts.has("status") ? ["status", ...keys] : keys;
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
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  };
  const facetSpot = (type: string, value: string) => filters.spotlight?.kind === "facet" && filters.spotlight.type === type && filters.spotlight.key === facetKey && filters.spotlight.value === value;
  const spotFacet = (type: string, value: string) => onChange({ ...filters, spotlight: facetSpot(type, value) ? null : { kind: "facet", type, key: facetKey, value } });
  const unassignedSpot = filters.spotlight?.kind === "unassigned";
  const outsideSpot = filters.spotlight?.kind === "outside";
  const glyphFor = (type: string) => SHAPE_GLYPH[shapeFor(type, homeSettings)];
  const [tab, setTabState] = useState<"explore" | "settings">(() => {
    try {
      return localStorage.getItem("brain-graph.sidebarTab") === "settings" ? "settings" : "explore";
    } catch {
      return "explore";
    }
  });
  const setTab = (t: "explore" | "settings") => {
    setTabState(t);
    try {
      localStorage.setItem("brain-graph.sidebarTab", t);
    } catch {
      /* ignore */
    }
  };
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("brain-graph.sidebarCollapsed") ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggleSection = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
    try {
      localStorage.setItem("brain-graph.sidebarCollapsed", JSON.stringify([...next]));
    } catch {
      /* ignore */
    }
  };
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
          <button className="tree-label" onClick={() => onFocusHub(id)} title={`${hub.type} · ${hub.subtreeCount} notes. Click to focus.`}>
            <span className="glyph" style={{ color: groupColor(homeIndex, id, homeLevel) }} title={hub.type}>
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

  const rolesAreDefault = edgeKinds.every((k) => linkRole(k.kind, homeSettings) === defaultLinkRole(k.kind));
  const groupingIsDefault = homeSettings.useHas && rolesAreDefault && homeSettings.hubTypes.size === homeDefaults.length && homeDefaults.every((t) => homeSettings.hubTypes.has(t));
  const setRole = (kind: string, role: LinkRole) => {
    const roles = { ...(homeSettings.roles ?? {}) };
    if (role === defaultLinkRole(kind)) delete roles[kind];
    else roles[kind] = role;
    p.onHomeSettings({ ...homeSettings, roles });
  };
  const hiddenTypes = types.filter((t) => !filters.types.has(t.name) && t.name !== "Type").length;

  return (
    <aside className="sidebar" ref={asideRef}>
      <div className="sidebar-tabs">
        <button className={tab === "explore" ? "on" : ""} onClick={() => setTab("explore")}>
          Explore
        </button>
        <button className={tab === "settings" ? "on" : ""} onClick={() => setTab("settings")}>
          Settings
        </button>
      </div>

      {tab === "explore" && (
        <>
          <Section id="groups" open={!collapsed.has("groups")} onToggle={toggleSection} title="Groups" badge={homeIndex.hubs.size}>
            <div className="muted small hint">
              {[...homeSettings.hubTypes].map((t) => `${glyphFor(t)} ${t}`).join(" · ")} · colour by {LEVEL_LABELS[homeLevel].toLowerCase()} ·{" "}
              <button className="link small" onClick={() => setTab("settings")}>
                change
              </button>
            </div>
            <ul className="tree">
              {homeIndex.roots.map(renderHub)}
              <li className={`tree-row unassigned${unassignedSpot ? " spotlit" : ""}`} title="Notes with no group. Click to focus.">
                <div className="tree-line">
                  <button className="disclosure empty" aria-hidden="true" />
                  <button className="tree-label" onClick={() => onChange({ ...filters, spotlight: unassignedSpot ? null : { kind: "unassigned" } })}>
                    <span className="glyph muted">○</span>
                    <span className="name muted">Unassigned</span>
                    <span className="count">{unassignedCount}</span>
                  </button>
                </div>
              </li>
              <li className={`tree-row unassigned${outsideSpot ? " spotlit" : ""}`} title="Notes never placed in a group. Click to focus.">
                <div className="tree-line">
                  <button className="disclosure empty" aria-hidden="true" />
                  <button className="tree-label" onClick={() => onChange({ ...filters, spotlight: outsideSpot ? null : { kind: "outside" } })}>
                    <span className="glyph" style={{ color: OUTSIDE_COLOR }}>●</span>
                    <span className="name muted">Outside the hierarchy</span>
                    <span className="count">{outsideCount}</span>
                  </button>
                </div>
              </li>
            </ul>
          </Section>

          <Section
            id="types"
            open={!collapsed.has("types")}
            onToggle={toggleSection}
            title="Types"
            badge={types.filter((t) => t.name !== "Type").length}
            tools={
              <>
                {facetKeys.length > 1 && (
                  <select className="facet-select" value={facetKey} onChange={(e) => setFacetKey(e.target.value)} title="Property whose values are listed under each type">
                    {facetKeys.map((k) => (
                      <option key={k} value={k}>
                        by {k}
                      </option>
                    ))}
                  </select>
                )}
                {hiddenTypes > 0 && (
                  <button className="link small" onClick={() => setAll("types", true)} title="Show all types">
                    show all
                  </button>
                )}
              </>
            }
          >
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
                      <button className="tree-label" onClick={() => spotType(t.name)} title={`${t.count} notes. Click to focus.`}>
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
          </Section>

          <Section
            id="links"
            open={!collapsed.has("links")}
            onToggle={toggleSection}
            title="Links"
            badge={edgeKinds.length}
            tools={
              <span className="muted small">
                <button className="link" onClick={() => setAll("kinds", true)}>
                  all
                </button>{" "}
                ·{" "}
                <button className="link" onClick={() => setAll("kinds", false)}>
                  none
                </button>
              </span>
            }
          >
            <ul className="legend">
              {edgeKinds.map((k) => {
                const on = filters.kinds.has(k.kind);
                const st = edgeStyle(k.kind);
                return (
                  <li key={k.kind} className={on ? "" : "off"}>
                    <button className="tree-label" onClick={(e) => toggle("kinds", k.kind, e.altKey)} title={on ? "Click to hide these links. Alt-click to show only these." : "Click to show these links"}>
                      <span className="edge-swatch" style={{ background: st.color, height: Math.max(1, st.width) }} />
                      <span className="name">
                        {k.kind}
                        {st.directed ? " →" : ""}
                        <span className="muted small"> · {ROLE_GLYPH[linkRole(k.kind, homeSettings)]} {ROLE_LABEL[linkRole(k.kind, homeSettings)]}</span>
                      </span>
                      <span className="count">{k.count}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Section>
        </>
      )}

      {tab === "settings" && (
        <>
          <Section
            id="grouping"
            title="Grouping"
            open={!collapsed.has("grouping")}
            onToggle={toggleSection}
            tools={
              !groupingIsDefault && (
                <button className="link small" onClick={() => p.onHomeSettings({ hubTypes: new Set(homeDefaults), useHas: true, palette: homeSettings.palette, roles: {} })} title={`Back to ${homeDefaults.join(", ")} and the default link roles`}>
                  reset
                </button>
              )
            }
          >
            <div className="muted small hint">
              Group types, in shape order. A note belongs to the nearest group up its <code>belongs_to</code> links. Suggested: {homeDefaults.join(", ")}.
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
            <div className="row column" title="Notes of these types are never placed in a group">
              <span>Outside the hierarchy</span>
              <div className="chips">
                {types
                  .filter((t) => t.name !== "Type" && t.name !== "(untyped)" && !homeSettings.hubTypes.has(t.name))
                  .map((t) => {
                    const exempt = homeSettings.exemptTypes ?? defaultExemptTypes(data);
                    const on = exempt.has(t.name);
                    return (
                      <button
                        key={t.name}
                        className={`chip${on ? " on" : ""}`}
                        title={on ? "Click to place these notes in groups again" : "Click to keep these notes out of groups"}
                        onClick={() => {
                          const next = new Set(exempt);
                          if (on) next.delete(t.name);
                          else next.add(t.name);
                          p.onHomeSettings({ ...homeSettings, exemptTypes: next });
                        }}
                      >
                        {t.name}
                      </button>
                    );
                  })}
              </div>
            </div>
            <div className="row column" title="What each link kind means. Click to switch between lateral, parent and children.">
              <span>Link roles</span>
              <div className="chips">
                {edgeKinds.map((k) => {
                  const role = linkRole(k.kind, homeSettings);
                  return (
                    <button key={k.kind} className={`chip${role !== "lateral" ? " on" : ""}`} onClick={() => setRole(k.kind, NEXT_ROLE[role])} title={`${k.kind}: ${ROLE_LABEL[role]}${role === defaultLinkRole(k.kind) ? " (default)" : ""}. Click to change.`}>
                      {ROLE_GLYPH[role]} {k.kind}
                    </button>
                  );
                })}
              </div>
            </div>
            <label className="row" title="Links such as has are used only when a note has no parent link">
              <input type="checkbox" checked={homeSettings.useHas} onChange={(e) => p.onHomeSettings({ ...homeSettings, useHas: e.target.checked })} />
              Use children links when a note has no parent
            </label>
          </Section>

          <Section
            id="layout"
            title="Layout"
            open={!collapsed.has("layout")}
            onToggle={toggleSection}
            tools={
              !layoutIsDefault && (
                <button className="link small" onClick={() => onLayoutSettings({ ...DEFAULT_LAYOUT, nodeScale: ls.nodeScale })}>
                  reset
                </button>
              )
            }
          >
            <label className="row column" title="How strongly notes are pulled to the centre. Lower spreads groups apart.">
              <span>
                Gravity: <strong>{ls.gravity}</strong>
              </span>
              <input type="range" min={0.1} max={3} step={0.1} value={ls.gravity} onChange={(e) => onLayoutSettings({ ...ls, gravity: Number(e.target.value) })} />
            </label>
            <label className="row column" title="How much harder parent and children links pull than other links">
              <span>
                Hierarchy pull: <strong>{ls.ratio}×</strong>
              </span>
              <input type="range" min={1} max={10} step={0.5} value={ls.ratio} onChange={(e) => onLayoutSettings({ ...ls, ratio: Number(e.target.value) })} />
            </label>
            <div className="row buttons">
              <button className="button" onClick={p.onResetLayout} disabled={p.layoutRunning} title="Lay out the whole map again from scratch. The current layout can be restored.">
                Reset layout
              </button>
              <button className="button" onClick={p.onRestoreLayout} disabled={!p.canRestoreLayout} title="Go back to the layout before the last change">
                Restore previous layout
              </button>
            </div>
          </Section>

          <Section id="appearance" title="Appearance" open={!collapsed.has("appearance")} onToggle={toggleSection}>
            <div className="subhead">Colour</div>
            <label className="row column" title="Which level of groups gets its own colour, region and name">
              <span>
                Colour by: <strong>{LEVEL_LABELS[homeLevel]}</strong>
              </span>
              <input type="range" min={0} max={2} value={homeLevel} onChange={(e) => p.onHomeLevel(Number(e.target.value) as HomeLevel)} />
            </label>
            <div className="row column" title="Sub-groups use shades of their parent's colour">
              <span>Palette</span>
              <div className="palette-grid">
                {(Object.keys(PALETTES) as PaletteId[]).map((id) => {
                  const on = (homeSettings.palette ?? DEFAULT_PALETTE) === id;
                  return (
                    <button key={id} className={`palette${on ? " on" : ""}`} onClick={() => p.onHomeSettings({ ...homeSettings, palette: id })} title={PALETTES[id].label}>
                      <span className="swatches">
                        {PALETTES[id].colors.slice(0, 8).map((c) => (
                          <span key={c} style={{ background: c }} />
                        ))}
                      </span>
                      <span className="small">{PALETTES[id].label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <label className="row" title="Notes fade after 7, 30 and 90 days without edits">
              <input type="checkbox" checked={filters.recency} onChange={(e) => onChange({ ...filters, recency: e.target.checked })} />
              Fade notes not edited recently
            </label>
            <div className="subhead">Regions and names</div>
            <label className="row" title="Shade the area of each group">
              <input type="checkbox" checked={filters.hulls} onChange={(e) => onChange({ ...filters, hulls: e.target.checked })} />
              Group regions
            </label>
            {filters.hulls && (
              <label className="row column indent" title="How far each region extends around its notes">
                <span>
                  Region size: <strong>{filters.regionSize}×</strong>
                </span>
                <input type="range" min={0.3} max={3} step={0.1} value={filters.regionSize} onChange={(e) => onChange({ ...filters, regionSize: Number(e.target.value) })} />
              </label>
            )}
            <label className="row" title="A group needs four visible notes to be named. Zoom in to see more.">
              <input type="checkbox" checked={filters.names} onChange={(e) => onChange({ ...filters, names: e.target.checked })} />
              Group names
            </label>
            <div className="subhead">Notes and links</div>
            <label className="row column">
              <span>
                Node size: <strong>{ls.nodeScale}×</strong>
              </span>
              <input type="range" min={0.4} max={2.5} step={0.1} value={ls.nodeScale} onChange={(e) => onLayoutSettings({ ...ls, nodeScale: Number(e.target.value) })} />
            </label>
            <label className="row column">
              <span>
                Link opacity: <strong>{Math.round(filters.linkOpacity * 100)}%</strong>
              </span>
              <input type="range" min={0.1} max={1} step={0.05} value={filters.linkOpacity} onChange={(e) => onChange({ ...filters, linkOpacity: Number(e.target.value) })} />
            </label>
            <label className="row column">
              <span>
                Link width: <strong>{filters.linkWidth}×</strong>
              </span>
              <input type="range" min={0.5} max={2.5} step={0.1} value={filters.linkWidth} onChange={(e) => onChange({ ...filters, linkWidth: Number(e.target.value) })} />
            </label>
            <div className="subhead">Labels</div>
            <label className="row column" title="Lower values show more labels at the same zoom">
              <span>
                Labels from node size: <strong>{filters.labelThreshold} px</strong>
              </span>
              <input type="range" min={2} max={14} step={1} value={filters.labelThreshold} onChange={(e) => onChange({ ...filters, labelThreshold: Number(e.target.value) })} />
            </label>
            <label className="row" title="Not only hovered and selected notes">
              <input type="checkbox" checked={filters.labels} onChange={(e) => onChange({ ...filters, labels: e.target.checked })} />
              All note labels
            </label>
          </Section>

          <Section id="filter" title="Filters" open={!collapsed.has("filter")} onToggle={toggleSection}>
            <div className="subhead">Hide</div>
            <label className="row">
              <input type="checkbox" checked={filters.hideArchived} onChange={(e) => onChange({ ...filters, hideArchived: e.target.checked })} />
              Hide archived notes
            </label>
            <label className="row">
              <input type="checkbox" checked={filters.hideOrphans} onChange={(e) => onChange({ ...filters, hideOrphans: e.target.checked })} />
              Hide orphans (no visible links)
            </label>
            <label className="row column" title="Group notes always stay">
              <span>
                Minimum links per note: <strong>{filters.minDegree === 0 ? "off" : filters.minDegree}</strong>
              </span>
              <input type="range" min={0} max={5} value={filters.minDegree} onChange={(e) => onChange({ ...filters, minDegree: Number(e.target.value) })} />
            </label>
            <div className="row column" title="Hide notes of these types and show their count on the note they belong to">
              <span>Collapse leaf types into their parent</span>
              <div className="chips">
                {leafTypes.map((t) => {
                  const on = filters.collapseTypes.includes(t.type);
                  return (
                    <button
                      key={t.type}
                      className={`chip${on ? " on" : ""}`}
                      title={`${t.count} notes, ${Math.round(t.leafShare * 100)}% with at most two links`}
                      onClick={() => onChange({ ...filters, collapseTypes: on ? filters.collapseTypes.filter((x) => x !== t.type) : [...filters.collapseTypes, t.type] })}
                    >
                      {t.type} <span className="count">{Math.round(t.leafShare * 100)}%</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <label className="row column" title="Show only notes within this many links of the selected note">
              <span>
                Around the selection: <strong>{filters.focusDepth === 0 ? "off" : `${filters.focusDepth} ${filters.focusDepth === 1 ? "link" : "links"}`}</strong>
                {!selected && filters.focusDepth > 0 && <span className="muted"> (select a note)</span>}
              </span>
              <input type="range" min={0} max={4} value={filters.focusDepth} onChange={(e) => onChange({ ...filters, focusDepth: Number(e.target.value) })} />
            </label>
            <div className="subhead">Also show</div>
            <label className="row" title="Blue for notes read by Claude Code or Codex, red for notes written by any app. Needs the agent hooks: brain-graph install-hooks.">
              <input type="checkbox" checked={filters.activity} onChange={(e) => onChange({ ...filters, activity: e.target.checked })} />
              Pulse notes as agents read and write them
            </label>
            <label className="row" title="Wikilinks to notes that do not exist, shown as grey dots">
              <input type="checkbox" checked={filters.ghosts} onChange={(e) => onChange({ ...filters, ghosts: e.target.checked })} />
              Show missing link targets ({new Set(data.unresolved.map((u) => u.raw.split("|")[0].split("#")[0].trim())).size})
            </label>
            {(data.bridges?.length ?? 0) > 0 && (
              <label className="row" title="Notes in other vaults that this vault links to, shown as rectangles">
                <input type="checkbox" checked={filters.bridges} onChange={(e) => onChange({ ...filters, bridges: e.target.checked })} />
                Show notes from other vaults ({new Set(data.bridges!.map((b) => `${b.vault}/${b.path}`)).size})
              </label>
            )}
            <div className="muted small hint">To hide a single type or link kind, use Explore → Types or Links.</div>
          </Section>
        </>
      )}
    </aside>
  );
}
