import { useEffect, useMemo, useRef, useState } from "react";
import { GraphView } from "./components/GraphView";
import { NotePanel, type PanelTab } from "./components/NotePanel";
import { ExternalPanel } from "./components/ExternalPanel";
import { Sidebar, type Filters } from "./components/Sidebar";
import { DEFAULT_LAYOUT, applyColors, applyEdgeWeights, applyNodeScale, buildGraph, collectPositions, neighborhood, placeStranded, typeColorMap, type LayoutSettings, type Positions } from "./graph/build";
import { DEFAULT_PALETTE, OUTSIDE_COLOR, PALETTES, SHAPE_GLYPH, buildHomeIndex, defaultHubTypes, isUnassigned, linkRole, outsideReason, shapeFor, subtreeMembers, type HomeLevel, type HomeSettings, type LinkRole, type PaletteId } from "./graph/home";
import { useSavedLayout, useVault, useVaults } from "./useVault";
import { getSetting, setSetting } from "./settingsStore";
import type { VaultGraph } from "./types";
import { VaultManager } from "./components/VaultManager";
import { Menu } from "./components/Menu";
import { replayStory } from "./graph/replay";
import { STATIC, apiFetch } from "./staticSite";

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
    // The title bar of an installed app (Safari's Dock app, Chrome's app window) follows the header colour.
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
      m.removeAttribute("media");
      m.setAttribute("content", dark ? "#111827" : "#ffffff");
    }
  }, [dark]);
  return {
    dark,
    toggle: () => setDark((d) => !d),
    graph: dark
      ? { background: "#0b0f17", label: "#e5e7eb", labelHalo: "#111827" }
      : { background: "#f8fafc", label: "#111827", labelHalo: "#ffffff" },
  };
}

// Layout runs: from scratch (first start, Alt-click) or a nudge of the existing map. New notes need no
// run: they are placed beside their strongest link and glide there (see buildGraph).
// Short, damped from the first frame: almost all the useful movement happens early anyway.
// `iterations` is ForceAtlas2 steps per animation frame: a first layout starts from a circle and needs
// well over a thousand steps to form clusters, a nudge of an existing map needs a few dozen.
// `maxStep` is a fraction of the map's span per frame.
const LAYOUT_RUNS = {
  scratch: { duration: 8000, start: 6, maxStep: 0.01, iterations: 5 },
  recompute: { duration: 750, start: 24, maxStep: 0.001, iterations: 2 },
  tune: { duration: 750, start: 24, maxStep: 0.001, iterations: 2 }, // live preview after a physics change
} as const;
type LayoutRun = keyof typeof LAYOUT_RUNS;

/** Draggable panel width, remembered per browser. `side` is where the panel sits: dragging the handle away from it widens it. */
function usePanelWidth(key: string, initial: number, side: "left" | "right", min = 180, max = 720) {
  // `max` may change with the window; a drag starts from the width actually shown, never from a stored
  // value larger than what fits (otherwise the handle would not react until the stored value caught up).
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
    const startW = Math.min(width, max);
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

/** The view as remembered per vault: every filter except hidden sets, which are stored by name so new types and kinds stay visible. */
type RememberedView = Partial<Omit<Filters, "types" | "kinds" | "spotlight">> & { hiddenTypes?: string[]; hiddenKinds?: string[]; collapseType?: string | null; collapseSources?: boolean };
function viewToFilters(f: Filters, v: RememberedView, data: VaultGraph): Filters {
  const hiddenTypes = new Set(v.hiddenTypes ?? ["Type"]);
  const hiddenKinds = new Set(v.hiddenKinds ?? DEFAULT_HIDDEN_KINDS);
  return {
    ...f,
    hideArchived: v.hideArchived ?? true,
    hideOrphans: v.hideOrphans ?? false,
    focusDepth: 0,
    // Older views stored one type (collapseType) or a Source flag.
    collapseTypes: v.collapseTypes ?? (v.collapseType ? [v.collapseType] : v.collapseSources ? ["Source"] : []),
    recency: v.recency ?? false,
    hulls: v.hulls ?? true,
    names: v.names ?? true,
    labels: v.labels ?? false,
    minDegree: v.minDegree ?? 0,
    regionSize: v.regionSize ?? 0.8,
    linkOpacity: v.linkOpacity ?? 0.3,
    ghosts: v.ghosts ?? false,
    bridges: v.bridges ?? true,
    activity: v.activity ?? true,
    linkWidth: v.linkWidth ?? 1,
    labelThreshold: v.labelThreshold ?? 7,
    types: new Set(data.types.map((t) => t.name).filter((t) => !hiddenTypes.has(t))),
    kinds: new Set(data.edgeKinds.map((k) => k.kind).filter((k) => !hiddenKinds.has(k))),
  };
}
function filtersToView(f: Filters, data: VaultGraph): RememberedView {
  const { types, kinds, spotlight: _sp, focusDepth: _fd, ...rest } = f;
  void _sp;
  void _fd;
  return { ...rest, hiddenTypes: data.types.map((t) => t.name).filter((t) => !types.has(t)), hiddenKinds: data.edgeKinds.map((k) => k.kind).filter((k) => !kinds.has(k)) };
}
/** A named view: the remembered filters plus focus and roll-up level, kept per vault in the browser. */
type SavedView = { name: string; view: RememberedView; focus: string | null; level: HomeLevel };
const readViews = (slug: string): SavedView[] => getSetting<SavedView[]>(slug, "views") ?? [];
/** Link kinds hidden until shown: links written in the note text. */
const DEFAULT_HIDDEN_KINDS = ["body"];
/** Colour level when the URL names none: each note's nearest group. */
const DEFAULT_LEVEL: HomeLevel = 2;

type Spotlight = Filters["spotlight"];
const spotlightToParam = (sp: Spotlight) => {
  if (!sp) return null;
  if (sp.kind === "type") return `type:${sp.value}`;
  if (sp.kind === "hub") return `hub:${sp.id}`;
  if (sp.kind === "facet") return `facet:${sp.type}:${sp.key}:${sp.value}`;
  if (sp.kind === "search") return `search:${sp.query}`;
  return sp.kind;
};
const paramToSpotlight = (v: string | null): Spotlight => {
  if (!v) return null;
  if (v === "unassigned" || v === "outside") return { kind: v };
  if (v.startsWith("type:")) return { kind: "type", value: v.slice(5) };
  if (v.startsWith("hub:")) return { kind: "hub", id: v.slice(4) };
  if (v.startsWith("search:") && v.length > 7) return { kind: "search", query: v.slice(7) };
  if (v.startsWith("facet:")) {
    const [type, key, ...rest] = v.slice(6).split(":");
    if (type && key && rest.length) return { kind: "facet", type, key, value: rest.join(":") };
  }
  return null;
};
const initialUrl = new URLSearchParams(window.location.search);

/** Notes whose parents changed between two versions of a vault. Groups (notes with children) stay where they are. */
function reparented(prev: VaultGraph, next: VaultGraph): string[] {
  const parents = (g: VaultGraph) => {
    const out = new Map<string, Set<string>>();
    const add = (child: string, parent: string) => (out.get(child) ?? out.set(child, new Set()).get(child)!).add(parent);
    for (const e of g.edges) {
      const role = linkRole(e.kind);
      if (role === "up") add(e.source, e.target);
      else if (role === "down") add(e.target, e.source);
    }
    return out;
  };
  const key = (set: Set<string> | undefined) => [...(set ?? [])].sort().join("|");
  const before = parents(prev);
  const after = parents(next);
  const groups = new Set([...after.values()].flatMap((set) => [...set]));
  const known = new Set(prev.nodes.map((n) => n.id));
  return next.nodes.map((n) => n.id).filter((id) => known.has(id) && !groups.has(id) && key(before.get(id)) !== key(after.get(id)));
}

export default function App() {
  const { vaults, registry, error: vaultsError, refresh: refreshVaults, addVault, removeVault, setUseTolaria } = useVaults();
  const [manageVaults, setManageVaults] = useState(false);
  const [wantedSlug, setVaultSlugState] = useState<string | null>(() => {
    if (initialUrl.get("vault")) return initialUrl.get("vault");
    try {
      return localStorage.getItem(VAULT_KEY);
    } catch {
      return null;
    }
  });
  const cameraStore = useRef<{ x: number; y: number; ratio: number; angle: number } | null>(null);
  // Only a vault the server still lists is opened. A remembered or linked vault that is gone (its folder
  // was moved, renamed or deleted) gives way to the default vault.
  const vaultSlug = wantedSlug && vaults?.some((v) => v.slug === wantedSlug) ? wantedSlug : null;
  useEffect(() => {
    if (!vaults?.length || vaultSlug) return;
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
  const { data, error, missing, reload } = useVault(vaultSlug);
  // The menu listed a vault the server no longer has: list again, which also switches to the default.
  useEffect(() => {
    if (missing) void refreshVaults();
  }, [missing]);
  // The graph keeps at least STAGE_MIN pixels; when the window is too narrow for both panels at their
  // chosen widths, the note panel yields (its chosen width is kept and comes back when there is room).
  const STAGE_MIN = 320;
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    // Observe the document rather than the resize event alone: emulated viewports and some embedded
    // webviews change the size without firing it.
    const update = () => setWindowWidth(document.documentElement.clientWidth || window.innerWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(document.documentElement);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);
  const sidebar = usePanelWidth("brain-graph.sidebarWidth", 260, "left", 180, Math.max(180, windowWidth - 12 - STAGE_MIN - 280));
  const panelMax = Math.max(280, Math.min(900, windowWidth - sidebar.width - 12 - STAGE_MIN));
  const panel = usePanelWidth("brain-graph.panelWidth", 420, "right", 280, panelMax);
  const panelWidthShown = Math.min(panel.width, panelMax);
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

  // The vault as last shown, to find notes whose parent changed when it is reloaded.
  const shownData = useRef<{ prev: VaultGraph | null; cur: VaultGraph | null }>({ prev: null, cur: null });
  if (shownData.current.cur !== data) shownData.current = { prev: shownData.current.cur, cur: data };
  const built = useMemo(() => {
    if (!data || seed === undefined || seed.vault !== data.vault.slug) return null;
    const prev = shownData.current.prev;
    return buildGraph(data, latestPositions.current ?? seed.positions, prev && prev.vault.slug === data.vault.slug ? reparented(prev, data) : []);
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
      const v0 = getSetting<unknown>(data.vault.slug, "grouping");
      if (v0) {
        const v = v0 as { hubTypes: string[]; useHas: boolean; palette?: string; roles?: Record<string, string>; exemptTypes?: string[] };
        const roles: Record<string, LinkRole> = {};
        for (const [k, r] of Object.entries(v.roles ?? {})) if (r === "up" || r === "down" || r === "lateral") roles[k] = r;
        if (Array.isArray(v.hubTypes) && v.hubTypes.length) next = { hubTypes: new Set(v.hubTypes), useHas: v.useHas !== false, palette: v.palette && v.palette in PALETTES ? (v.palette as PaletteId) : DEFAULT_PALETTE, roles, exemptTypes: Array.isArray(v.exemptTypes) ? new Set(v.exemptTypes) : undefined };
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
      if (data) setSetting(data.vault.slug, "grouping", { hubTypes: [...next.hubTypes], useHas: next.useHas, palette: next.palette ?? DEFAULT_PALETTE, roles: next.roles ?? {}, exemptTypes: next.exemptTypes ? [...next.exemptTypes] : undefined });
    } catch {
      /* ignore */
    }
  };
  const homeIndex = useMemo(() => (data && homeSettings && homeSettingsVault === data.vault.slug ? buildHomeIndex(data, homeSettings) : null), [data, homeSettings, homeSettingsVault]);
  const byId = useMemo(() => new Map(data?.nodes.map((n) => [n.id, n]) ?? []), [data]);

  const [homeLevel, setHomeLevel] = useState<HomeLevel>(() => {
    const raw = initialUrl.get("level");
    const v = raw === null ? DEFAULT_LEVEL : Number(raw);
    return v === 0 || v === 1 || v === 2 ? (v as HomeLevel) : DEFAULT_LEVEL;
  });

  const [filters, setFilters] = useState<Filters>({
    types: new Set(),
    kinds: new Set(),
    hideArchived: true,
    hideOrphans: false,
    focusDepth: 0,
    collapseTypes: [],
    recency: false,
    hulls: true,
    names: true,
    labels: false,
    spotlight: null,
    minDegree: 0,
    regionSize: 0.8,
    linkOpacity: 0.3,
    linkWidth: 1,
    labelThreshold: 7,
    ghosts: false,
    bridges: true,
    activity: true,
  });
  // Initialise filters from the data once: everything visible except body links (too noisy by default).
  const [initialised, setInitialised] = useState<string | null>(null);
  useEffect(() => {
    if (!data || initialised === data.vault.slug) return;
    // View filters are remembered per vault; types or kinds that no longer exist are dropped, new ones shown.
    let remembered: RememberedView = {};
    try {
      remembered = getSetting<RememberedView>(data.vault.slug, "view") ?? {};
    } catch {
      /* ignore */
    }
    setFilters((f) => ({ ...viewToFilters(f, remembered, data), spotlight: initialised === null ? paramToSpotlight(initialUrl.get("focus")) : null }));
    setViews(readViews(data.vault.slug));
    setActiveView(null);
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
  const [exportRequest, setExportRequest] = useState(0);
  const [exportState, setExportState] = useState<"idle" | "busy" | "error">("idle");
  const [query, setQuery] = useState("");

  // Layout physics, remembered per vault.
  const [layoutSettings, setLayoutSettingsState] = useState<LayoutSettings>(DEFAULT_LAYOUT);
  const [layoutSettingsVault, setLayoutSettingsVault] = useState<string | null>(null);
  useEffect(() => {
    if (!data || layoutSettingsVault === data.vault.slug) return;
    let next = DEFAULT_LAYOUT;
    try {
      const v = getSetting<Record<string, unknown>>(data.vault.slug, "layout");
      if (v) {
        // Only finite numbers within range survive; anything else (older keys, null, NaN) falls back to the default.
        const num = (k: keyof LayoutSettings, min: number, max: number) => {
          const x = v[k];
          return typeof x === "number" && Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : DEFAULT_LAYOUT[k];
        };
        next = { nodeScale: num("nodeScale", 0.4, 2.5), gravity: num("gravity", 0.1, 3), ratio: num("ratio", 1, 10) };
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
      if (data) setSetting(data.vault.slug, "layout", next);
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

  // A map without saved positions gets a full run. A restored map needs none: notes placed while
  // building it (new, re-parented or stranded) are saved where they were put.
  useEffect(() => {
    if (!built) return;
    if (!built.restored) return setLayoutRun("scratch");
    if (built.fresh.length === 0) return;
    const positions = collectPositions(built.graph);
    latestPositions.current = positions;
    void saved.save(positions);
  }, [built]);
  // Which link kinds the last layout run used: toggling kinds changes the forces but does not re-run.
  const layoutKinds = useRef<Set<string> | null>(null);
  const onLayoutStopped = (positions: Positions, vault: string) => {
    // A run can end while the vault is being switched: never let another vault's positions leak into this one.
    if (vault !== vaultSlug) return setLayoutRun(null);
    layoutKinds.current = new Set(filters.kinds);
    latestPositions.current = positions;
    if (graph) for (const [id, [x, y]] of Object.entries(positions)) if (graph.hasNode(id)) graph.mergeNodeAttributes(id, { x, y });
    setLayoutRun(null);
    void saved.save(positions);
  };
  const restorePreviousLayout = async () => {
    const r = await apiFetch(`/api/layout/restore?vault=${encodeURIComponent(vaultSlug ?? "")}`, { method: "POST" });
    if (!r.ok) return;
    const l = (await r.json()) as { positions: Positions };
    latestPositions.current = null;
    setSeed((s) => ({ positions: l.positions, nonce: (s?.nonce ?? 0) + 1, vault: vaultSlug }));
  };
  const recompute = async (fromScratch: boolean) => {
    if (layoutRun) return setLayoutRun(null);
    if (fromScratch) {
      await saved.reset();
      latestPositions.current = null;
      setSeed((s) => ({ positions: null, nonce: (s?.nonce ?? 0) + 1, vault: vaultSlug }));
      setFitRequest((n) => n + 1);
    } else {
      // The nudge only moves notes a little; outliers far from all their links are re-placed first.
      if (filteredGraph) for (const n of placeStranded(filteredGraph)) graph?.mergeNodeAttributes(n, { x: filteredGraph.getNodeAttribute(n, "x"), y: filteredGraph.getNodeAttribute(n, "y") });
      setLayoutRun("recompute");
    }
  };

  // Edge-kind filtering works on a copy of the graph; node filters use hidden state in the renderer.
  const filteredGraph = useMemo(() => {
    if (!graph || !data) return null;
    const g = graph.copy();
    g.forEachEdge((e, a) => {
      if (a.kind === "missing" ? !filters.ghosts : a.kind === "cross-vault" ? !filters.bridges : !filters.kinds.has(a.kind)) g.dropEdge(e);
    });
    return g;
  }, [graph, data, filters.kinds, filters.ghosts, filters.bridges]);

  // Node size multiplier is a display setting: no run needed.
  useEffect(() => {
    if (filteredGraph) applyNodeScale(filteredGraph, layoutSettings.nodeScale);
  }, [filteredGraph, layoutSettings.nodeScale]);

  // Hierarchy pull is an edge attribute read by the layout on every step.
  useEffect(() => {
    if (graph) applyEdgeWeights(graph, layoutSettings.ratio, homeSettings ?? undefined);
    if (filteredGraph) applyEdgeWeights(filteredGraph, layoutSettings.ratio, homeSettings ?? undefined);
  }, [graph, filteredGraph, layoutSettings.ratio, homeSettings]);

  // Colours are node attributes, so switching mode never rebuilds the renderer.
  useEffect(() => {
    if (filteredGraph && homeIndex) applyColors(filteredGraph, homeLevel, homeIndex);
  }, [filteredGraph, homeIndex, homeLevel]);

  // Labels carry the folded Source count; opacity carries recency. Both are plain attributes.
  useEffect(() => {
    if (!filteredGraph || !graph) return;
    const sourceCount = new Map<string, number>();
    if (filters.collapseTypes.length) {
      const ct = new Set(filters.collapseTypes);
      graph.forEachEdge((_e, a, s, t) => {
        if (a.kind === "belongs_to" && ct.has(graph.getNodeAttribute(s, "type"))) sourceCount.set(t, (sourceCount.get(t) ?? 0) + 1);
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
  }, [filteredGraph, graph, byId, filters.collapseTypes, filters.recency]);

  const hidden = useMemo(() => {
    const set = new Set<string>();
    if (!filteredGraph || !data || !homeIndex) return set;
    for (const n of data.nodes) {
      const t = n.type ?? "(untyped)";
      if (!filters.types.has(t)) set.add(n.id);
      else if (filters.collapseTypes.includes(t)) set.add(n.id);
      else if (filters.hideArchived && n.archived) set.add(n.id);
    }
    if (!filters.ghosts) filteredGraph.forEachNode((n, a) => void (a.ghost && set.add(n)));
    if (!filters.bridges) filteredGraph.forEachNode((n, a) => void (a.bridge && set.add(n)));
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
    } else if (sp.kind === "search") {
      const q = sp.query.toLowerCase();
      for (const n of data.nodes) if ((n.title.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)) && !hidden.has(n.id)) set.add(n.id);
    } else if (sp.kind === "outside") {
      for (const n of data.nodes) if (outsideReason(n, homeIndex) && !hidden.has(n.id)) set.add(n.id);
    } else {
      // Unassigned: notes that are not groups themselves, reach no group and are not outside by design.
      for (const n of data.nodes) if (isUnassigned(n, homeIndex) && !hidden.has(n.id)) set.add(n.id);
    }
    // Notes of other vaults and missing targets follow the notes that link to them.
    filteredGraph?.forEachNode((n, a) => {
      if ((a.bridge || a.ghost) && !hidden.has(n) && filteredGraph.someNeighbor(n, (m) => set.has(m))) set.add(n);
    });
    return set;
  }, [filters.spotlight, data, homeIndex, hidden, filteredGraph]);
  // Candidates for collapsing: types with enough notes, biggest first, with the share of their notes
  // that are leaves in the current view (at most two visible links) as a hint.
  const leafTypes = useMemo(() => {
    if (!data || !filteredGraph) return [];
    const stats = new Map<string, { count: number; leaves: number }>();
    for (const n of data.nodes) {
      const t = n.type ?? "(untyped)";
      if (t === "Type") continue;
      const st = stats.get(t) ?? { count: 0, leaves: 0 };
      st.count++;
      if (filteredGraph.hasNode(n.id) && filteredGraph.degree(n.id) <= 2) st.leaves++;
      stats.set(t, st);
    }
    return [...stats.entries()]
      .map(([type, st]) => ({ type, count: st.count, leafShare: st.leaves / st.count }))
      .filter((t) => t.count >= 10)
      .sort((a, b) => b.count - a.count);
  }, [data, filteredGraph]);
  const unassignedCount = useMemo(() => (data && homeIndex ? data.nodes.filter((n) => isUnassigned(n, homeIndex)).length : 0), [data, homeIndex]);
  const outsideCount = useMemo(() => (data && homeIndex ? data.nodes.filter((n) => outsideReason(n, homeIndex)).length : 0), [data, homeIndex]);

  const matches = useMemo(() => {
    if (!data || query.trim().length < 2) return [];
    const q = query.trim().toLowerCase();
    return data.nodes
      .filter((n) => n.title.toLowerCase().includes(q) || n.id.toLowerCase().includes(q))
      .sort((a, b) => (a.title.toLowerCase().startsWith(q) ? -1 : 1) - (b.title.toLowerCase().startsWith(q) ? -1 : 1) || b.inDegree - a.inDegree)
      .slice(0, 12);
  }, [data, query]);

  // Panel navigation history: every selection of a different note is a step, remembered with the tab
  // that was open; back/forward replay both. A newly opened note starts on its text.
  type Step = { id: string; tab: PanelTab };
  const [panelTab, setPanelTab] = useState<PanelTab>("note");
  const history = useRef<{ past: Step[]; future: Step[] }>({ past: [], future: [] });
  const [historyVersion, setHistoryVersion] = useState(0);
  const select = (id: string | null, center = false, record = true) => {
    if (record && id && selected && id !== selected) {
      history.current.past.push({ id: selected, tab: panelTab });
      history.current.future = [];
      setHistoryVersion((v) => v + 1);
    }
    if (record && id !== selected) setPanelTab("note");
    setSelected(id);
    if (id && center) setFocusRequest({ node: id, nonce: Date.now() });
  };
  const goBack = () => {
    const prev = history.current.past.pop();
    if (!prev) return;
    if (selected) history.current.future.push({ id: selected, tab: panelTab });
    setHistoryVersion((v) => v + 1);
    select(prev.id, true, false);
    setPanelTab(prev.tab);
  };
  const goForward = () => {
    const next = history.current.future.pop();
    if (!next) return;
    if (selected) history.current.past.push({ id: selected, tab: panelTab });
    setHistoryVersion((v) => v + 1);
    select(next.id, true, false);
    setPanelTab(next.tab);
  };
  void historyVersion;
  // Home row click: focus the group and open its note; clicking the focused group again clears both.
  const focusHub = (id: string) => {
    const already = filters.spotlight?.kind === "hub" && filters.spotlight.id === id;
    setFilters((f) => ({ ...f, spotlight: already ? null : { kind: "hub", id } }));
    if (already) setSelected(null);
    else select(id, true);
  };
  // Remember the view filters per vault (not the spotlight: that is URL state).
  useEffect(() => {
    if (!data || initialised !== data.vault.slug) return;
    try {
      setSetting(data.vault.slug, "view", filtersToView(filters, data));
    } catch {
      /* ignore */
    }
  }, [filters, data, initialised]);

  // Named views: pick one from the state line, save the current one, delete the active one.
  const [views, setViews] = useState<SavedView[]>([]);
  const [activeView, setActiveView] = useState<string | null>(null);
  const writeViews = (slug: string, next: SavedView[]) => {
    setViews(next);
    try {
      setSetting(slug, "views", next);
    } catch {
      /* ignore */
    }
  };
  const applyView = (v: SavedView | null) => {
    if (!data) return;
    setFilters((f) => ({ ...viewToFilters(f, v?.view ?? {}, data), spotlight: paramToSpotlight(v?.focus ?? null) }));
    setHomeLevel(v?.level ?? DEFAULT_LEVEL);
    setActiveView(v?.name ?? null);
  };
  const saveView = () => {
    if (!data) return;
    const name = window.prompt("Name this view", activeView ?? "")?.trim();
    if (!name) return;
    const next: SavedView = { name, view: filtersToView(filters, data), focus: spotlightToParam(filters.spotlight), level: homeLevel };
    writeViews(data.vault.slug, [...views.filter((v) => v.name !== name), next].sort((a, b) => a.name.localeCompare(b.name)));
    setActiveView(name);
  };
  const deleteView = () => {
    if (!data || !activeView || !window.confirm(`Delete the view “${activeView}”?`)) return;
    writeViews(data.vault.slug, views.filter((v) => v.name !== activeView));
    setActiveView(null);
  };

  // Where an agent's read or write is drawn: on the note, or on its parent when its type is folded into
  // the parent's count; nowhere when a filter hides it (it would glow on an empty spot).
  const pulseTarget = (id: string): string | null => {
    if (!filteredGraph || !filteredGraph.hasNode(id)) return null;
    if (!hidden.has(id)) return id;
    const type = byId.get(id)?.type ?? "(untyped)";
    if (!filters.collapseTypes.includes(type)) return null;
    // The same belongs_to link that adds it to the parent's "+n" count.
    let parent: string | null = null;
    graph?.forEachOutEdge(id, (_e, a, _s, t) => {
      if (!parent && a.kind === "belongs_to" && !hidden.has(t)) parent = t;
    });
    return parent;
  };

  // Static demo only, where no agent reports to the page: replay what a session looks like (graph/replay.ts),
  // around the open note first when there is one. Clicking again restarts it; another vault cancels it.
  const replayTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const stopReplay = () => {
    replayTimers.current.forEach(clearTimeout);
    replayTimers.current = [];
  };
  useEffect(() => stopReplay, [data?.vault.slug]);
  const replayActivity = () => {
    if (!data || !filteredGraph) return;
    stopReplay();
    const g = filteredGraph;
    const degree = (id: string) => byId.get(id)!.inDegree + byId.get(id)!.outDegree;
    const shown = (id: string) => byId.has(id) && g.hasNode(id) && !hidden.has(id);
    const byDegree = (ids: string[]) => ids.filter(shown).sort((a, b) => degree(b) - degree(a));
    const projects = byDegree(data.nodes.filter((n) => n.type === "Project").map((n) => n.id));
    const hubs = [...new Set([...(selected && shown(selected) ? [selected] : []), ...(projects.length >= 4 ? projects : byDegree(data.nodes.map((n) => n.id)))])];
    const slug = data.vault.slug;
    replayTimers.current = replayStory({ slug, hubs, linked: (id) => byDegree([...new Set(g.neighbors(id))]) }).map((step) =>
      setTimeout(() => window.dispatchEvent(new CustomEvent("brain-graph-activity", { detail: { vault: slug, id: step.id, kind: step.kind, source: step.source, time: Date.now() } })), step.at),
    );
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

  // Window title: the open note, then the vault, so a tab, the Window menu or an installed app names what is shown.
  useEffect(() => {
    if (!data) return;
    const note = selected ? byId.get(selected)?.title : null;
    document.title = [note, data.vault.label, "Brain Graph"].filter(Boolean).join(" · ");
  }, [data, selected, byId]);

  // Shareable URL: vault, selected note, focus and roll-up level.
  useEffect(() => {
    if (!data) return;
    const q = new URLSearchParams();
    q.set("vault", data.vault.slug);
    if (selected) q.set("note", selected);
    const sp = spotlightToParam(filters.spotlight);
    if (sp) q.set("focus", sp);
    if (homeLevel !== DEFAULT_LEVEL) q.set("level", String(homeLevel));
    const url = `${window.location.pathname}?${q.toString()}`;
    if (url !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", url);
  }, [data, selected, filters.spotlight, homeLevel]);

  // Clicking the graph is a new intent: a node click shows that node's neighbourhood, a stage click clears everything.
  const clickGraph = (id: string | null) => {
    if (id && filteredGraph?.getNodeAttribute(id, "ghost")) return;
    setFilters((f) => (f.spotlight ? { ...f, spotlight: null } : f));
    select(id);
  };

  if (vaultsError) return <div className="status error">Could not list the vaults: {vaultsError}</div>;
  // A vault that fails to load must not trap the page: offer the other vaults.
  if (error)
    return (
      <div className="status">
        <p className="error">Could not load this vault: {error}</p>
        {registry && <VaultManager registry={registry} current={vaultSlug} onSelect={setVaultSlug} onAdd={addVault} onRemove={removeVault} onUseTolaria={setUseTolaria} onClose={() => undefined} />}
      </div>
    );
  if (vaults && vaults.length === 0 && registry)
    return (
      <div className="status">
        <VaultManager registry={registry} current={null} onSelect={setVaultSlug} onAdd={addVault} onRemove={removeVault} onUseTolaria={setUseTolaria} onClose={() => undefined} />
      </div>
    );
  if (!data || !graph || !filteredGraph || !homeIndex || !homeSettings) return <div className="status">Parsing vault…</div>;

  const hoveredNode = hovered ? byId.get(hovered) : null;
  // Colour as drawn on the map (the note's group); the type is shown as a neutral tag with its shape.
  const mapColor = (id: string) => (filteredGraph.hasNode(id) ? (filteredGraph.getNodeAttribute(id, "color") as string) : undefined);
  const typeTag = (type: string | null) => `${SHAPE_GLYPH[shapeFor(type, homeSettings)]} ${type ?? "untyped"}`;
  // Type badges take the Type note's own colour, as in Tolaria's sidebar (a tint, so it is not read as a map colour).
  const typeTagStyle = (type: string | null) => {
    const c = typeColors.get(type ?? "(untyped)");
    return c ? ({ color: c, borderColor: c, background: `color-mix(in srgb, ${c} 14%, transparent)` } as React.CSSProperties) : undefined;
  };
  // Deviations from the default view, each with its own undo. Defaults themselves (body links hidden,
  // archived hidden) are not listed, so an empty line means "the default view".
  const defaultKinds = (k: string) => !DEFAULT_HIDDEN_KINDS.includes(k);
  const stateParts: { label: string; title: string; clear: () => void }[] = [];
  if (filters.spotlight) {
    const sp = filters.spotlight;
    const what = sp.kind === "type" ? sp.value : sp.kind === "hub" ? (byId.get(sp.id)?.title ?? sp.id) : sp.kind === "facet" ? `${sp.type} · ${sp.key} = ${sp.value}` : sp.kind === "search" ? `“${sp.query}” (${spotlight?.size ?? 0})` : sp.kind === "outside" ? "notes outside the hierarchy" : "unassigned notes";
    stateParts.push({ label: `focused: ${what}`, title: "Click × to unfocus", clear: () => setFilters((f) => ({ ...f, spotlight: null })) });
  }
  const hiddenTypes = data.types.filter((t) => !filters.types.has(t.name) && t.name !== "Type");
  if (hiddenTypes.length)
    stateParts.push({
      label: hiddenTypes.length === 1 ? `${hiddenTypes[0].name} hidden` : `${hiddenTypes.length} types hidden`,
      title: `Hidden: ${hiddenTypes.map((t) => t.name).join(", ")}`,
      clear: () => setFilters((f) => ({ ...f, types: new Set(data.types.map((t) => t.name).filter((t) => t !== "Type")) })),
    });
  const hiddenKinds = data.edgeKinds.filter((k) => !filters.kinds.has(k.kind) && defaultKinds(k.kind));
  if (hiddenKinds.length)
    stateParts.push({
      label: hiddenKinds.length === 1 ? `${hiddenKinds[0].kind} links hidden` : `${hiddenKinds.length} link kinds hidden`,
      title: `Hidden: ${hiddenKinds.map((k) => k.kind).join(", ")}`,
      clear: () => setFilters((f) => ({ ...f, kinds: new Set(data.edgeKinds.map((k) => k.kind).filter((k) => defaultKinds(k) || f.kinds.has(k))) })),
    });
  for (const k of DEFAULT_HIDDEN_KINDS.filter((x) => filters.kinds.has(x))) stateParts.push({ label: `${k} links shown`, title: "Hidden by default", clear: () => setFilters((f) => ({ ...f, kinds: new Set([...f.kinds].filter((x) => x !== k)) })) });
  if (filters.collapseTypes.length) stateParts.push({ label: filters.collapseTypes.length === 1 ? `${filters.collapseTypes[0]} collapsed` : `${filters.collapseTypes.length} types collapsed`, title: `${filters.collapseTypes.join(", ")} notes are counted on their parent`, clear: () => setFilters((f) => ({ ...f, collapseTypes: [] })) });
  if (filters.minDegree) stateParts.push({ label: `notes with < ${filters.minDegree} links hidden`, title: "Notes with few links are hidden", clear: () => setFilters((f) => ({ ...f, minDegree: 0 })) });
  if (filters.recency) stateParts.push({ label: "faded by recency", title: "Notes not edited recently are faded", clear: () => setFilters((f) => ({ ...f, recency: false })) });
  if (!filters.activity) stateParts.push({ label: "activity pulses off", title: "Shown by default", clear: () => setFilters((f) => ({ ...f, activity: true })) });
  if (!filters.bridges && (data.bridges?.length ?? 0) > 0) stateParts.push({ label: "other-vault notes hidden", title: "Shown by default", clear: () => setFilters((f) => ({ ...f, bridges: true })) });
  if (filters.ghosts) stateParts.push({ label: "missing targets shown", title: "Links to missing notes are shown as grey dots", clear: () => setFilters((f) => ({ ...f, ghosts: false })) });
  if (!filters.hideArchived) stateParts.push({ label: "archived shown", title: "Archived notes are hidden by default", clear: () => setFilters((f) => ({ ...f, hideArchived: true })) });
  if (filters.focusDepth) stateParts.push({ label: `${filters.focusDepth} ${filters.focusDepth === 1 ? "link" : "links"} around selection`, title: "Only notes near the selection are shown", clear: () => setFilters((f) => ({ ...f, focusDepth: 0 })) });
  const kindsChanged = layoutKinds.current !== null && (layoutKinds.current.size !== filters.kinds.size || [...filters.kinds].some((k) => !layoutKinds.current!.has(k)));
  const selectedNode = selected ? byId.get(selected) : null;
  // A note of another vault, or a missing target: on the map but not in this vault's notes.
  const satellite = (id: string | null) => (id && !byId.has(id) && filteredGraph.hasNode(id) ? filteredGraph.getNodeAttributes(id) : null);
  const selectedBridge = satellite(selected)?.bridge ? satellite(selected) : null;
  const hoveredSat = satellite(hovered);
  const visibleCount = data.nodes.reduce((n, note) => n + (hidden.has(note.id) ? 0 : 1), 0);
  const run = layoutRun ? LAYOUT_RUNS[layoutRun] : LAYOUT_RUNS.recompute;

  return (
    <div
      className={`app${sidebar.dragging || panel.dragging ? " resizing" : ""}${selectedNode || selectedBridge ? " with-panel" : ""}`}
      style={{ "--sidebar-w": `${sidebar.width}px`, "--panel-w": `${panelWidthShown}px` } as React.CSSProperties}
    >
      <header className="topbar">
        <div className="brand">
          <Menu
            className="vault-picker"
            label={`Vault: ${data.vault.label}`}
            title={STATIC ? "Choose a vault" : data.vault.path}
            button={<span className="vault-name">{data.vault.label}</span>}
            items={[
              ...(vaults ?? []).map((v) => ({ key: v.slug, label: v.label, title: STATIC ? undefined : v.path, checked: v.slug === data.vault.slug, onSelect: () => setVaultSlug(v.slug) })),
              ...(STATIC ? [] : [{ key: "__manage__", label: "Manage vaults…", separated: true, onSelect: () => setManageVaults(true) }]),
            ]}
          />
          <span className="muted">
            {visibleCount}/{data.nodes.length} notes · {filteredGraph.size} links
            {saved.layout && !layoutRun && ` · layout saved ${new Date(saved.layout.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
            {built?.fresh.length ? ` · ${built.fresh.length} new` : ""}
          </span>
        </div>
        <div className="search">
          <input
            type="search"
            placeholder="Search notes"
            title="Enter opens a single match, or focuses all matches"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches[0]) {
                if (matches.length === 1) select(matches[0].id, true);
                else setFilters((f) => ({ ...f, spotlight: { kind: "search", query: query.trim() } }));
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
                    <span className="dot" style={{ background: mapColor(m.id) }} />
                    <span className="name">{m.title}</span>
                    <span className="small" style={{ color: typeColors.get(m.type ?? "(untyped)") }}>{typeTag(m.type)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="toolbar">
          <button
            className="button"
            onClick={() => void recompute(false)}
            title={layoutRun ? "Stop and keep the current positions" : "Tidy the map from its current positions"}
          >
            {layoutRun ? `Settling… ${Math.round(layoutProgress * 100)}% · Stop` : "Update layout"}
          </button>
          <button className="button" onClick={() => setFitRequest((n) => n + 1)}>Fit</button>
          {STATIC && (
            <button className="button" onClick={replayActivity} title="Show how notes pulse as two agents read them (blue) and write them (red), starting from the open note if there is one">
              Replay agent
            </button>
          )}
          <button
            className="button"
            disabled={exportState === "busy"}
            onClick={() => {
              setExportState("busy");
              setExportRequest((n) => n + 1);
            }}
            title="Save the current view as a PNG image"
          >
            {exportState === "busy" ? "Exporting…" : exportState === "error" ? "Export failed" : "Export PNG"}
          </button>
          <button className="button" onClick={reload} title={`Parsed ${new Date(data.generatedAt).toLocaleTimeString()}`}>↻</button>
          <button className="button" onClick={theme.toggle} title="Toggle theme">{theme.dark ? "☀" : "☾"}</button>
        </div>
        {layoutRun && <div className="progress" style={{ width: `${layoutProgress * 100}%` }} />}
      </header>
      <div className={`stateline${stateParts.length === 0 && !kindsChanged ? " empty" : ""}`}>
        <Menu
          className="view-select"
          label={`Saved view: ${activeView ?? "Default view"}`}
          title="Saved views"
          button={<span className="view-name">{activeView ?? "Default view"}</span>}
          items={[
            { key: "", label: "Default view", checked: !activeView, onSelect: () => applyView(null) },
            ...views.map((v) => ({ key: `view:${v.name}`, label: v.name, checked: v.name === activeView, onSelect: () => applyView(v) })),
            { key: "__save__", label: "Save current view…", separated: true, onSelect: saveView },
            ...(activeView ? [{ key: "__delete__", label: `Delete “${activeView}”`, onSelect: deleteView }] : []),
          ]}
        />
          <span className="chips-inline">
            {stateParts.map((part) => (
              <span key={part.label} className="state-chip" title={part.title}>
                {part.label}
                <button className="chip-x" onClick={part.clear} aria-label={`Undo: ${part.label}`} title={part.title}>
                  ×
                </button>
              </span>
            ))}
            {kindsChanged && (
              <span className="state-chip stale" title="The layout was computed with other link kinds">
                link kinds changed ·{" "}
                <button className="link small" onClick={() => void recompute(false)}>
                  update layout
                </button>
              </span>
            )}
          </span>
      </div>

      <Sidebar
        data={data}
        types={data.types}
        typeColors={typeColors}
        homeIndex={homeIndex}
        homeSettings={homeSettings}
        homeDefaults={vaultDefaults}
        leafTypes={leafTypes}
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
        outsideCount={outsideCount}
        layoutSettings={layoutSettings}
        onLayoutSettings={setLayoutSettings}
        layoutRunning={layoutRun !== null}
        canRestoreLayout={!!saved.layout?.hasPrevious}
        onRestoreLayout={() => void restorePreviousLayout()}
        onResetLayout={() => void recompute(true)}
      />

      <div className={`gutter${sidebar.dragging ? " active" : ""}`} onMouseDown={sidebar.startDrag} title="Drag to resize the sidebar" />

      <main className="stage">
        <GraphView
          key={theme.dark ? "dark" : "light"}
          graph={filteredGraph}
          hidden={hidden}
          selected={selected}
          layoutRunning={layoutRun !== null}
          arrivals={built?.arrivals ?? null}
          layoutDuration={run.duration}
          layoutStart={run.start}
          layoutMaxStep={run.maxStep}
          layoutIterations={run.iterations}
          layoutSettings={layoutSettings}
          theme={theme.graph}
          hulls={filters.hulls || filters.names ? { index: homeIndex, level: homeLevel, hidden, data, regionSize: filters.regionSize, regions: filters.hulls, names: filters.names } : null}
          showLabels={filters.labels}
          linkOpacity={filters.linkOpacity}
          linkWidth={filters.linkWidth}
          showActivity={filters.activity}
          pulseTarget={pulseTarget}
          labelThreshold={filters.labelThreshold}
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
          exportRequest={exportRequest}
          onExported={(ok) => setExportState(ok ? "idle" : "error")}
          cameraStore={cameraStore}
        />
        {hoveredNode && pointer && (
          <div className="tooltip" style={{ left: pointer.x + 14, top: pointer.y + 14 }}>
            <div className="tip-head">
              <span className="type-tag" style={typeTagStyle(hoveredNode.type)}>{typeTag(hoveredNode.type)}</span>
              {(() => {
                const home = homeIndex.homes.get(hoveredNode.id);
                const groupId = homeIndex.hubs.has(hoveredNode.id) ? hoveredNode.id : home?.hub;
                const outside = outsideReason(hoveredNode, homeIndex);
                return groupId ? (
                  <span className="group-tag">
                    <span className="dot" style={{ background: mapColor(hoveredNode.id) }} />
                    {byId.get(groupId)?.title ?? groupId}
                    {home?.lateral && <span title="No parent: coloured by a related group"> (related)</span>}
                  </span>
                ) : outside ? (
                  <span className="group-tag">
                    <span className="dot" style={{ background: OUTSIDE_COLOR }} />
                    no group ({outside})
                  </span>
                ) : null;
              })()}
            </div>
            <strong>{hoveredNode.title}</strong>
            <div className="muted small">
              {hoveredNode.status ?? "—"} · {hoveredNode.inDegree} in · {hoveredNode.outDegree} out
            </div>
            {hoveredNode.summary && <p>{hoveredNode.summary}</p>}
          </div>
        )}
        {hoveredSat && pointer && (
          <div className="tooltip" style={{ left: pointer.x + 14, top: pointer.y + 14 }}>
            <div className="tip-head">
              <span className="type-tag">{hoveredSat.bridge ? `▬ ${hoveredSat.bridge.type ?? "note"}` : "missing link target"}</span>
              {hoveredSat.bridge && <span className="group-tag">{hoveredSat.bridge.vaultLabel}</span>}
            </div>
            <strong>{hoveredSat.label}</strong>
            <div className="muted small">
              {hoveredSat.bridge ? "linked from" : "mentioned by"} {hoveredSat.degree} {hoveredSat.degree === 1 ? "note" : "notes"} here{hoveredSat.bridge ? " · click to read" : ""}
            </div>
            {hoveredSat.bridge?.summary && <p>{hoveredSat.bridge.summary}</p>}
          </div>
        )}
      </main>

      {manageVaults && registry && (
        <VaultManager
          registry={registry}
          current={data.vault.slug}
          onSelect={(slug) => {
            setVaultSlug(slug);
            setManageVaults(false);
          }}
          onAdd={addVault}
          onRemove={removeVault}
          onUseTolaria={setUseTolaria}
          onClose={() => setManageVaults(false)}
        />
      )}
      {(selectedNode || selectedBridge) && <div className={`gutter gutter-right${panel.dragging ? " active" : ""}`} onMouseDown={panel.startDrag} title="Drag to resize the panel" />}
      {selectedBridge?.bridge && selected && (
        <ExternalPanel
          data={data}
          graph={filteredGraph}
          id={selected}
          title={selectedBridge.label}
          bridge={selectedBridge.bridge}
          onSelect={(id) => select(id, true)}
          onClose={() => setSelected(null)}
          canBack={history.current.past.length > 0}
          canForward={history.current.future.length > 0}
          onBack={goBack}
          onForward={goForward}
        />
      )}
      {selectedNode && (
        <NotePanel
          data={data}
          graph={filteredGraph}
          node={selectedNode}
          typeColors={typeColors}
          homeIndex={homeIndex}
          level={homeLevel}
          onSelect={(id) => select(id, true)}
          onClose={() => setSelected(null)}
          tab={panelTab}
          onTab={setPanelTab}
          canBack={history.current.past.length > 0}
          canForward={history.current.future.length > 0}
          onBack={goBack}
          onForward={goForward}
        />
      )}
    </div>
  );
}
