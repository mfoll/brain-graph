import { useEffect, useMemo, useRef, useState } from "react";
import { GraphView } from "./components/GraphView";
import { NotePanel } from "./components/NotePanel";
import { Sidebar, type Filters } from "./components/Sidebar";
import { DEFAULT_LAYOUT, applyColors, applyEdgeWeights, applyNodeScale, buildGraph, neighborhood, typeColorMap, type LayoutSettings, type Positions } from "./graph/build";
import { buildHomeIndex, defaultHubTypes, subtreeMembers, type HomeLevel, type HomeSettings } from "./graph/home";
import { useSavedLayout, useVault, useVaults } from "./useVault";

function useTheme() {
  const [dark, setDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const fn = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  return {
    dark,
    toggle: () => setDark((d) => !d),
    graph: dark
      ? { background: "#0b0f17", label: "#e5e7eb", labelHalo: "#111827" }
      : { background: "#f8fafc", label: "#111827", labelHalo: "#ffffff" },
  };
}

// Layout runs: from scratch (first start, Alt-click), a nudge of the existing map, or settling new notes.
// Short, damped from the first frame: almost all the useful movement happens early anyway.
const LAYOUT_RUNS = {
  scratch: { duration: 4000, start: 14, maxStep: 3 },
  recompute: { duration: 1500, start: 30, maxStep: 0.8 },
  tune: { duration: 1500, start: 30, maxStep: 0.8 }, // live preview after a physics change, from the current positions
  settle: { duration: 1500, start: 30, maxStep: 1.5 },
} as const;
type LayoutRun = keyof typeof LAYOUT_RUNS;

/** Draggable panel width, remembered per browser. `side` is where the panel sits: dragging the handle away from it widens it. */
function usePanelWidth(key: string, initial: number, side: "left" | "right", min = 180, max = 720) {
  const [width, setWidth] = useState(() => {
    try {
      const v = Number(localStorage.getItem(key));
      return v >= min && v <= max ? v : initial;
    } catch {
      return initial;
    }
  });
  const [dragging, setDragging] = useState(false);
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const sign = side === "left" ? 1 : -1;
    setDragging(true);
    const move = (ev: MouseEvent) => setWidth(Math.min(max, Math.max(min, startW + sign * (ev.clientX - startX))));
    const up = () => {
      setDragging(false);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setWidth((w) => {
        try {
          localStorage.setItem(key, String(w));
        } catch {
          /* private mode: ignore */
        }
        return w;
      });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  return { width, dragging, startDrag };
}

const VAULT_KEY = "brain-graph.vault";

type Spotlight = Filters["spotlight"];
const spotlightToParam = (sp: Spotlight) => {
  if (!sp) return null;
  if (sp.kind === "type") return `type:${sp.value}`;
  if (sp.kind === "hub") return `hub:${sp.id}`;
  if (sp.kind === "facet") return `facet:${sp.type}:${sp.key}:${sp.value}`;
  return "unassigned";
};
const paramToSpotlight = (v: string | null): Spotlight => {
  if (!v) return null;
  if (v === "unassigned") return { kind: "unassigned" };
  if (v.startsWith("type:")) return { kind: "type", value: v.slice(5) };
  if (v.startsWith("hub:")) return { kind: "hub", id: v.slice(4) };
  if (v.startsWith("facet:")) {
    const [type, key, ...rest] = v.slice(6).split(":");
    if (type && key && rest.length) return { kind: "facet", type, key, value: rest.join(":") };
  }
  return null;
};
const initialUrl = new URLSearchParams(window.location.search);

export default function App() {
  const { vaults, error: vaultsError } = useVaults();
  const [vaultSlug, setVaultSlugState] = useState<string | null>(() => {
    if (initialUrl.get("vault")) return initialUrl.get("vault");
    try {
      return localStorage.getItem(VAULT_KEY);
    } catch {
      return null;
    }
  });
  const cameraStore = useRef<{ x: number; y: number; ratio: number; angle: number } | null>(null);
  // Resolve the initial vault once the list is known: remembered choice if still served, else the default.
  useEffect(() => {
    if (!vaults?.length) return;
    if (vaultSlug && vaults.some((v) => v.slug === vaultSlug)) return;
    setVaultSlugState((vaults.find((v) => v.isDefault) ?? vaults[0]).slug);
  }, [vaults, vaultSlug]);
  const setVaultSlug = (slug: string) => {
    setVaultSlugState(slug);
    try {
      localStorage.setItem(VAULT_KEY, slug);
    } catch {
      /* ignore */
    }
  };
  const { data, error, reload } = useVault(vaultSlug);
  const sidebar = usePanelWidth("brain-graph.sidebarWidth", 260, "left");
  const panel = usePanelWidth("brain-graph.panelWidth", 420, "right", 280, 900);
  const saved = useSavedLayout(vaultSlug);
  const theme = useTheme();

  // Positions used to seed the graph: the saved layout on first load, nothing after a reset.
  // Later layout runs update `latestPositions` (a ref, so saving never rebuilds the graph).
  const [seed, setSeed] = useState<{ positions: Positions | null; nonce: number; vault: string | null } | undefined>(undefined);
  const latestPositions = useRef<Positions | null>(null);
  useEffect(() => {
    if (saved.layout === undefined) return;
    if (seed === undefined || seed.vault !== vaultSlug) {
      latestPositions.current = null;
      setSeed({ positions: saved.layout?.positions ?? null, nonce: 0, vault: vaultSlug });
    }
  }, [saved.layout, seed, vaultSlug]);

  const built = useMemo(() => {
    if (!data || seed === undefined || seed.vault !== data.vault.slug) return null;
    return buildGraph(data, latestPositions.current ?? seed.positions);
  }, [data, seed]);
  const graph = built?.graph ?? null;
  const typeColors = useMemo(() => (data ? typeColorMap(data) : new Map<string, string>()), [data]);
  // Grouping is remembered per vault; the default depends on the vault's ontology.
  const [homeSettings, setHomeSettingsState] = useState<HomeSettings | null>(null);
  const [homeSettingsVault, setHomeSettingsVault] = useState<string | null>(null);
  const vaultDefaults = useMemo(() => (data ? defaultHubTypes(data) : []), [data]);
  useEffect(() => {
    if (!data || homeSettingsVault === data.vault.slug) return;
    let next: HomeSettings = { hubTypes: new Set(vaultDefaults), useHas: true };
    try {
      const raw = localStorage.getItem(`brain-graph.grouping.${data.vault.slug}`);
      if (raw) {
        const v = JSON.parse(raw) as { hubTypes: string[]; useHas: boolean };
        if (Array.isArray(v.hubTypes) && v.hubTypes.length) next = { hubTypes: new Set(v.hubTypes), useHas: v.useHas !== false };
      }
    } catch {
      /* ignore */
    }
    setHomeSettingsState(next);
    setHomeSettingsVault(data.vault.slug);
  }, [data, vaultDefaults, homeSettingsVault]);
  const setHomeSettings = (next: HomeSettings) => {
    setHomeSettingsState(next);
    try {
      if (data) localStorage.setItem(`brain-graph.grouping.${data.vault.slug}`, JSON.stringify({ hubTypes: [...next.hubTypes], useHas: next.useHas }));
    } catch {
      /* ignore */
    }
  };
  const homeIndex = useMemo(() => (data && homeSettings && homeSettingsVault === data.vault.slug ? buildHomeIndex(data, homeSettings) : null), [data, homeSettings, homeSettingsVault]);
  const byId = useMemo(() => new Map(data?.nodes.map((n) => [n.id, n]) ?? []), [data]);

  const [homeLevel, setHomeLevel] = useState<HomeLevel>(() => {
    const raw = initialUrl.get("level");
    const v = raw === null ? 1 : Number(raw);
    return v === 0 || v === 1 || v === 2 ? (v as HomeLevel) : 1;
  });

  const [filters, setFilters] = useState<Filters>({
    types: new Set(),
    kinds: new Set(),
    hideArchived: true,
    hideOrphans: false,
    focusDepth: 0,
    collapseSources: false,
    recency: false,
    hulls: true,
    labels: false,
    spotlight: null,
    minDegree: 0,
    regionSize: 1,
  });
  // Initialise filters from the data once: everything visible except body links (too noisy by default).
  const [initialised, setInitialised] = useState<string | null>(null);
  useEffect(() => {
    if (!data || initialised === data.vault.slug) return;
    setFilters((f) => ({
      ...f,
      types: new Set(data.types.map((t) => t.name).filter((t) => t !== "Type")),
      kinds: new Set(data.edgeKinds.map((k) => k.kind).filter((k) => k !== "body")),
      spotlight: initialised === null ? paramToSpotlight(initialUrl.get("focus")) : null,
    }));
    const urlNote = initialised === null ? initialUrl.get("note") : null;
    setSelected(urlNote && data.nodes.some((n) => n.id === urlNote) ? urlNote : null);
    history.current = { past: [], future: [] };
    setHovered(null);
    if (initialised !== null) {
      // Another vault: its map has its own frame; start from a full view instead of the previous camera.
      cameraStore.current = null;
      setFitRequest((n) => n + 1);
    }
    setInitialised(data.vault.slug);
  }, [data, initialised]);

  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [layoutRun, setLayoutRun] = useState<LayoutRun | null>(null);
  const [layoutProgress, setLayoutProgress] = useState(0);
  const [focusRequest, setFocusRequest] = useState<{ node: string; nonce: number } | null>(null);
  const [fitRequest, setFitRequest] = useState(0);
  const [query, setQuery] = useState("");

  // Layout physics, remembered per vault.
  const [layoutSettings, setLayoutSettingsState] = useState<LayoutSettings>(DEFAULT_LAYOUT);
  const [layoutSettingsVault, setLayoutSettingsVault] = useState<string | null>(null);
  useEffect(() => {
    if (!data || layoutSettingsVault === data.vault.slug) return;
    let next = DEFAULT_LAYOUT;
    try {
      const raw = localStorage.getItem(`brain-graph.layout.${data.vault.slug}`);
      if (raw) {
        const v = JSON.parse(raw) as Partial<LayoutSettings> & Record<string, unknown>;
        next = { ...DEFAULT_LAYOUT, ...Object.fromEntries(Object.entries(v).filter(([k]) => k in DEFAULT_LAYOUT)) } as LayoutSettings;
      }
    } catch {
      /* ignore */
    }
    setLayoutSettingsState(next);
    setLayoutSettingsVault(data.vault.slug);
  }, [data, layoutSettingsVault]);
  // Changing the physics starts (or extends) a short live run so the effect shows at once.
  const tuneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setLayoutSettings = (next: LayoutSettings) => {
    setLayoutSettingsState(next);
    try {
      if (data) localStorage.setItem(`brain-graph.layout.${data.vault.slug}`, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    if (next.nodeScale !== layoutSettings.nodeScale && JSON.stringify({ ...next, nodeScale: 0 }) === JSON.stringify({ ...layoutSettings, nodeScale: 0 })) return; // display only
    if (tuneTimer.current) clearTimeout(tuneTimer.current);
    tuneTimer.current = setTimeout(() => {
      setLayoutRun(null);
      setTimeout(() => setLayoutRun("tune"), 0);
    }, 150);
  };

  // A restored map needs no layout; new notes get a short settling run with everything else pinned.
  const layoutPins = useMemo(() => {
    if (!built || !built.restored || built.fresh.length === 0) return null;
    const fresh = new Set(built.fresh);
    return new Set(built.graph.nodes().filter((n) => !fresh.has(n)));
  }, [built]);
  useEffect(() => {
    if (!built) return;
    if (!built.restored) setLayoutRun("scratch");
    else if (built.fresh.length > 0) setLayoutRun("settle");
  }, [built]);
  // Which link kinds the last layout run used: toggling kinds changes the forces but does not re-run.
  const layoutKinds = useRef<Set<string> | null>(null);
  const onLayoutStopped = (positions: Positions) => {
    layoutKinds.current = new Set(filters.kinds);
    latestPositions.current = positions;
    if (graph) for (const [id, [x, y]] of Object.entries(positions)) if (graph.hasNode(id)) graph.mergeNodeAttributes(id, { x, y });
    setLayoutRun(null);
    void saved.save(positions);
  };
  const recompute = async (fromScratch: boolean) => {
    if (layoutRun) return setLayoutRun(null);
    if (fromScratch) {
      await saved.reset();
      latestPositions.current = null;
      setSeed((s) => ({ positions: null, nonce: (s?.nonce ?? 0) + 1, vault: vaultSlug }));
      setFitRequest((n) => n + 1);
    } else setLayoutRun("recompute");
  };

  // Edge-kind filtering works on a copy of the graph; node filters use hidden state in the renderer.
  const filteredGraph = useMemo(() => {
    if (!graph || !data) return null;
    const g = graph.copy();
    g.forEachEdge((e, a) => {
      if (!filters.kinds.has(a.kind)) g.dropEdge(e);
    });
    return g;
  }, [graph, data, filters.kinds]);

  // Node size multiplier is a display setting: no run needed.
  useEffect(() => {
    if (filteredGraph) applyNodeScale(filteredGraph, layoutSettings.nodeScale);
  }, [filteredGraph, layoutSettings.nodeScale]);

  // Hierarchy pull is an edge attribute read by the layout on every step.
  useEffect(() => {
    if (graph) applyEdgeWeights(graph, layoutSettings.hierarchyWeight);
    if (filteredGraph) applyEdgeWeights(filteredGraph, layoutSettings.hierarchyWeight);
  }, [graph, filteredGraph, layoutSettings.hierarchyWeight]);

  // Colours are node attributes, so switching mode never rebuilds the renderer.
  useEffect(() => {
    if (filteredGraph && homeIndex) applyColors(filteredGraph, homeLevel, homeIndex);
  }, [filteredGraph, homeIndex, homeLevel]);

  // Labels carry the folded Source count; opacity carries recency. Both are plain attributes.
  useEffect(() => {
    if (!filteredGraph || !graph) return;
    const sourceCount = new Map<string, number>();
    if (filters.collapseSources) {
      graph.forEachEdge((_e, a, s, t) => {
        if (a.kind === "belongs_to" && graph.getNodeAttribute(s, "type") === "Source") sourceCount.set(t, (sourceCount.get(t) ?? 0) + 1);
      });
    }
    const now = Date.now();
    filteredGraph.updateEachNodeAttributes(
      (id, a) => {
        const note = byId.get(id);
        const n = sourceCount.get(id);
        const label = n ? `${note?.title ?? a.label} +${n}` : (note?.title ?? a.label);
        let recency = 1;
        if (filters.recency && note) {
          const days = (now - new Date(note.modified).getTime()) / 86_400_000;
          recency = days < 7 ? 1 : days < 30 ? 0.7 : days < 90 ? 0.4 : 0.15;
        }
        return { ...a, label, recency };
      },
      { attributes: ["label", "recency"] },
    );
  }, [filteredGraph, graph, byId, filters.collapseSources, filters.recency]);

  const hidden = useMemo(() => {
    const set = new Set<string>();
    if (!filteredGraph || !data || !homeIndex) return set;
    for (const n of data.nodes) {
      const t = n.type ?? "(untyped)";
      if (!filters.types.has(t)) set.add(n.id);
      else if (filters.collapseSources && t === "Source") set.add(n.id);
      else if (filters.hideArchived && n.archived) set.add(n.id);
    }
    if (filters.minDegree > 0) {
      // Skeleton view: drop notes with too few visible links, iterating since removals lower others' degrees.
      let changed = true;
      while (changed) {
        changed = false;
        filteredGraph.forEachNode((n) => {
          if (set.has(n) || homeIndex.hubs.has(n)) return;
          let d = 0;
          filteredGraph.forEachNeighbor(n, (m) => {
            if (!set.has(m)) d++;
          });
          if (d < filters.minDegree) {
            set.add(n);
            changed = true;
          }
        });
      }
    }
    if (filters.hideOrphans) {
      filteredGraph.forEachNode((n) => {
        if (set.has(n)) return;
        let visibleDegree = 0;
        filteredGraph.forEachNeighbor(n, (m) => {
          if (!set.has(m)) visibleDegree++;
        });
        if (visibleDegree === 0) set.add(n);
      });
    }
    if (filters.focusDepth > 0 && selected && filteredGraph.hasNode(selected)) {
      const keep = neighborhood(filteredGraph, selected, filters.focusDepth);
      filteredGraph.forEachNode((n) => {
        if (!keep.has(n)) set.add(n);
      });
      set.delete(selected);
    }
    return set;
  }, [filteredGraph, data, homeIndex, filters, selected]);

  // Notes to keep lit when a type or a home group is focused in the sidebar (hidden ones excluded).
  const spotlight = useMemo(() => {
    const sp = filters.spotlight;
    if (!sp || !data || !homeIndex) return null;
    const set = new Set<string>();
    if (sp.kind === "type") {
      for (const n of data.nodes) if ((n.type ?? "(untyped)") === sp.value && !hidden.has(n.id)) set.add(n.id);
    } else if (sp.kind === "hub") {
      for (const id of subtreeMembers(sp.id, data, homeIndex)) if (!hidden.has(id)) set.add(id);
    } else if (sp.kind === "facet") {
      for (const n of data.nodes) if ((n.type ?? "(untyped)") === sp.type && String(n.properties[sp.key] ?? "") === sp.value && !hidden.has(n.id)) set.add(n.id);
    } else {
      // Unassigned: notes that are not groups themselves and whose chain reaches no group.
      for (const n of data.nodes) if (n.type !== "Type" && !homeIndex.hubs.has(n.id) && !homeIndex.homes.get(n.id)?.hub && !hidden.has(n.id)) set.add(n.id);
    }
    return set;
  }, [filters.spotlight, data, homeIndex, hidden]);
  const unassignedCount = useMemo(
    () => (data && homeIndex ? data.nodes.filter((n) => n.type !== "Type" && !homeIndex.hubs.has(n.id) && !homeIndex.homes.get(n.id)?.hub).length : 0),
    [data, homeIndex],
  );

  const matches = useMemo(() => {
    if (!data || query.trim().length < 2) return [];
    const q = query.trim().toLowerCase();
    return data.nodes
      .filter((n) => n.title.toLowerCase().includes(q) || n.id.toLowerCase().includes(q))
      .sort((a, b) => (a.title.toLowerCase().startsWith(q) ? -1 : 1) - (b.title.toLowerCase().startsWith(q) ? -1 : 1) || b.inDegree - a.inDegree)
      .slice(0, 12);
  }, [data, query]);

  // Panel navigation history: every selection of a different note is a step; back/forward replay them.
  const history = useRef<{ past: string[]; future: string[] }>({ past: [], future: [] });
  const [historyVersion, setHistoryVersion] = useState(0);
  const select = (id: string | null, center = false, record = true) => {
    if (record && id && selected && id !== selected) {
      history.current.past.push(selected);
      history.current.future = [];
      setHistoryVersion((v) => v + 1);
    }
    setSelected(id);
    if (id && center) setFocusRequest({ node: id, nonce: Date.now() });
  };
  const goBack = () => {
    const prev = history.current.past.pop();
    if (!prev) return;
    if (selected) history.current.future.push(selected);
    setHistoryVersion((v) => v + 1);
    select(prev, true, false);
  };
  const goForward = () => {
    const next = history.current.future.pop();
    if (!next) return;
    if (selected) history.current.past.push(selected);
    setHistoryVersion((v) => v + 1);
    select(next, true, false);
  };
  void historyVersion;
  // Home row click: focus the group and open its note; clicking the focused group again clears both.
  const focusHub = (id: string) => {
    const already = filters.spotlight?.kind === "hub" && filters.spotlight.id === id;
    setFilters((f) => ({ ...f, spotlight: already ? null : { kind: "hub", id } }));
    if (already) setSelected(null);
    else select(id, true);
  };
  // Escape: unfocus first, then close the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (filters.spotlight) setFilters((f) => ({ ...f, spotlight: null }));
      else if (selected) setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filters.spotlight, selected]);

  // Shareable URL: vault, selected note, focus and roll-up level.
  useEffect(() => {
    if (!data) return;
    const q = new URLSearchParams();
    q.set("vault", data.vault.slug);
    if (selected) q.set("note", selected);
    const sp = spotlightToParam(filters.spotlight);
    if (sp) q.set("focus", sp);
    if (homeLevel !== 1) q.set("level", String(homeLevel));
    const url = `${window.location.pathname}?${q.toString()}`;
    if (url !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", url);
  }, [data, selected, filters.spotlight, homeLevel]);

  // Clicking the graph is a new intent: a node click shows that node's neighbourhood, a stage click clears everything.
  const clickGraph = (id: string | null) => {
    setFilters((f) => (f.spotlight ? { ...f, spotlight: null } : f));
    select(id);
  };

  if (error || vaultsError) return <div className="status error">Could not load the vault graph: {error ?? vaultsError}</div>;
  if (vaults && vaults.length === 0) return <div className="status error">No vault to show: register one in Tolaria or start with VAULT=~/path/to/vault.</div>;
  if (!data || !graph || !filteredGraph || !homeIndex || !homeSettings) return <div className="status">Parsing vault…</div>;

  const hoveredNode = hovered ? byId.get(hovered) : null;
  const stateParts: string[] = [];
  if (filters.spotlight) {
    const sp = filters.spotlight;
    stateParts.push(
      `focused: ${sp.kind === "type" ? sp.value : sp.kind === "hub" ? (byId.get(sp.id)?.title ?? sp.id) : sp.kind === "facet" ? `${sp.type} · ${sp.key} = ${sp.value}` : "unassigned notes"}`,
    );
  }
  const hiddenTypes = data.types.filter((t) => !filters.types.has(t.name) && t.name !== "Type").length;
  if (hiddenTypes) stateParts.push(`${hiddenTypes} type${hiddenTypes > 1 ? "s" : ""} hidden`);
  const hiddenKinds = data.edgeKinds.filter((k) => !filters.kinds.has(k.kind));
  if (hiddenKinds.length) stateParts.push(hiddenKinds.length === 1 ? `${hiddenKinds[0].kind} links hidden` : `${hiddenKinds.length} link kinds hidden`);
  if (filters.collapseSources) stateParts.push("Sources collapsed");
  if (filters.minDegree) stateParts.push(`notes with < ${filters.minDegree} links hidden`);
  if (filters.recency) stateParts.push("faded by recency");
  if (!filters.hideArchived) stateParts.push("archived shown");
  if (filters.focusDepth) stateParts.push(`depth ${filters.focusDepth} around selection`);
  const kindsChanged = layoutKinds.current !== null && (layoutKinds.current.size !== filters.kinds.size || [...filters.kinds].some((k) => !layoutKinds.current!.has(k)));
  const selectedNode = selected ? byId.get(selected) : null;
  const visibleCount = data.nodes.length - hidden.size;
  const run = layoutRun ? LAYOUT_RUNS[layoutRun] : LAYOUT_RUNS.recompute;

  return (
    <div
      className={`app${sidebar.dragging || panel.dragging ? " resizing" : ""}${selectedNode ? " with-panel" : ""}`}
      style={{ "--sidebar-w": `${sidebar.width}px`, "--panel-w": `${panel.width}px` } as React.CSSProperties}
    >
      <header className="topbar">
        <div className="brand">
          {vaults && vaults.length > 1 ? (
            <select className="vault-select" value={data.vault.slug} onChange={(e) => setVaultSlug(e.target.value)} title={data.vault.path}>
              {vaults.map((v) => (
                <option key={v.slug} value={v.slug}>
                  {v.label}
                </option>
              ))}
            </select>
          ) : (
            <strong>{data.vault.label}</strong>
          )}
          <span className="muted">
            {visibleCount}/{data.nodes.length} notes · {filteredGraph.size} links
            {saved.layout && !layoutRun && ` · layout saved ${new Date(saved.layout.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
            {built?.fresh.length ? ` · ${built.fresh.length} new` : ""}
          </span>
        </div>
        <div className="search">
          <input
            type="search"
            placeholder="Search notes…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches[0]) {
                select(matches[0].id, true);
                setQuery("");
              }
              if (e.key === "Escape") setQuery("");
            }}
          />
          {matches.length > 0 && (
            <ul className="results">
              {matches.map((m) => (
                <li key={m.id}>
                  <button
                    onClick={() => {
                      select(m.id, true);
                      setQuery("");
                    }}
                  >
                    <span className="dot" style={{ background: typeColors.get(m.type ?? "(untyped)") }} />
                    <span className="name">{m.title}</span>
                    <span className="muted small">{m.type}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="toolbar">
          <button
            className="button"
            onClick={(e) => void recompute(e.altKey)}
            title={
              layoutRun
                ? "Stop now and keep the current positions"
                : "Nudge the layout from the current positions (1.5 s, cools down and saves by itself). Alt-click to start again from scratch."
            }
          >
            {layoutRun ? `Settling… ${Math.round(layoutProgress * 100)}% · Stop` : "Recompute layout"}
          </button>
          <button className="button" onClick={() => setFitRequest((n) => n + 1)}>Fit</button>
          <button className="button" onClick={reload} title={`Parsed ${new Date(data.generatedAt).toLocaleTimeString()}`}>↻</button>
          <button className="button" onClick={theme.toggle} title="Toggle theme">{theme.dark ? "☀" : "☾"}</button>
        </div>
        {layoutRun && <div className="progress" style={{ width: `${layoutProgress * 100}%` }} />}
      </header>
      {(stateParts.length > 0 || kindsChanged) && (
        <div className="stateline">
          <span>
            {stateParts.join(" · ")}
            {kindsChanged && (
              <>
                {stateParts.length > 0 && " · "}
                <span title="The visible link kinds changed since the last layout run; the positions still reflect the previous set.">
                  links changed since the last layout ·{" "}
                  <button className="link small" onClick={() => void recompute(false)}>
                    recompute
                  </button>
                </span>
              </>
            )}
          </span>
          <button
            className="link small"
            onClick={() =>
              setFilters((f) => ({
                ...f,
                spotlight: null,
                types: new Set(data.types.map((t) => t.name).filter((t) => t !== "Type")),
                kinds: new Set(data.edgeKinds.map((k) => k.kind).filter((k) => k !== "body")),
                collapseSources: false,
                minDegree: 0,
                recency: false,
                hideArchived: true,
                focusDepth: 0,
              }))
            }
          >
            clear
          </button>
        </div>
      )}

      <Sidebar
        data={data}
        types={data.types}
        typeColors={typeColors}
        homeIndex={homeIndex}
        homeSettings={homeSettings}
        homeDefaults={vaultDefaults}
        onHomeSettings={setHomeSettings}
        homeLevel={homeLevel}
        onHomeLevel={setHomeLevel}
        edgeKinds={data.edgeKinds}
        filters={filters}
        onChange={setFilters}
        selected={selected}
        onSelect={(id) => select(id, true)}
        onFocusHub={focusHub}
        unassignedCount={unassignedCount}
        layoutSettings={layoutSettings}
        onLayoutSettings={setLayoutSettings}
        layoutRunning={layoutRun !== null}
      />

      <div className={`gutter${sidebar.dragging ? " active" : ""}`} onMouseDown={sidebar.startDrag} title="Drag to resize the sidebar" />

      <main className="stage">
        <GraphView
          key={theme.dark ? "dark" : "light"}
          graph={filteredGraph}
          hidden={hidden}
          selected={selected}
          layoutRunning={layoutRun !== null}
          layoutPins={layoutPins}
          layoutDuration={run.duration}
          layoutStart={run.start}
          layoutMaxStep={run.maxStep}
          layoutSettings={layoutSettings}
          theme={theme.graph}
          hulls={filters.hulls ? { index: homeIndex, level: homeLevel, hidden, data, regionSize: filters.regionSize } : null}
          showLabels={filters.labels}
          spotlight={spotlight}
          emphasisHub={filters.spotlight?.kind === "hub" ? filters.spotlight.id : null}
          onHover={(node, pos) => {
            if (node !== undefined) setHovered(node);
            if (pos) setPointer(pos);
          }}
          onSelect={clickGraph}
          onLayoutStopped={onLayoutStopped}
          onLayoutProgress={setLayoutProgress}
          focusRequest={focusRequest}
          fitRequest={fitRequest}
          cameraStore={cameraStore}
        />
        {hoveredNode && pointer && (
          <div className="tooltip" style={{ left: pointer.x + 14, top: pointer.y + 14 }}>
            <div className="type-chip" style={{ background: typeColors.get(hoveredNode.type ?? "(untyped)") }}>{hoveredNode.type ?? "untyped"}</div>
            <strong>{hoveredNode.title}</strong>
            <div className="muted small">
              {hoveredNode.status ?? "—"} · {hoveredNode.inDegree} in · {hoveredNode.outDegree} out
              {(() => {
                const h = homeIndex.homes.get(hoveredNode.id)?.hub;
                return h && h !== hoveredNode.id ? ` · ${byId.get(h)?.title ?? h}` : "";
              })()}
            </div>
            {hoveredNode.summary && <p>{hoveredNode.summary}</p>}
          </div>
        )}
      </main>

      {selectedNode && <div className={`gutter gutter-right${panel.dragging ? " active" : ""}`} onMouseDown={panel.startDrag} title="Drag to resize the panel" />}
      {selectedNode && (
        <NotePanel
          data={data}
          graph={filteredGraph}
          node={selectedNode}
          typeColors={typeColors}
          homeIndex={homeIndex}
          onSelect={(id) => select(id, true)}
          onClose={() => setSelected(null)}
          canBack={history.current.past.length > 0}
          canForward={history.current.future.length > 0}
          onBack={goBack}
          onForward={goForward}
        />
      )}
    </div>
  );
}
