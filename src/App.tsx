import { useEffect, useMemo, useRef, useState } from "react";
import { GraphView } from "./components/GraphView";
import { NotePanel } from "./components/NotePanel";
import { Sidebar, type Filters } from "./components/Sidebar";
import { buildGraph, neighborhood, typeColorMap, type Positions } from "./graph/build";
import { useSavedLayout, useVault } from "./useVault";

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

export default function App() {
  const { data, error, reload } = useVault();
  const saved = useSavedLayout();
  const theme = useTheme();

  // Positions used to seed the graph: the saved layout on first load, nothing after a reset.
  // Later layout runs update `latestPositions` (a ref, so saving never rebuilds the graph).
  const [seed, setSeed] = useState<{ positions: Positions | null; nonce: number } | undefined>(undefined);
  useEffect(() => {
    if (saved.layout !== undefined && seed === undefined) setSeed({ positions: saved.layout?.positions ?? null, nonce: 0 });
  }, [saved.layout, seed]);
  const latestPositions = useRef<Positions | null>(null);

  const built = useMemo(() => {
    if (!data || seed === undefined) return null;
    return buildGraph(data, latestPositions.current ?? seed.positions);
  }, [data, seed]);
  const graph = built?.graph ?? null;
  const typeColors = useMemo(() => (data ? typeColorMap(data) : new Map<string, string>()), [data]);
  const byId = useMemo(() => new Map(data?.nodes.map((n) => [n.id, n]) ?? []), [data]);

  const [filters, setFilters] = useState<Filters>({
    types: new Set(),
    kinds: new Set(),
    hideArchived: true,
    hideOrphans: false,
    focusDepth: 0,
  });
  // Initialise filters from the data once: everything visible except body links (too noisy by default).
  const [initialised, setInitialised] = useState(false);
  useEffect(() => {
    if (!data || initialised) return;
    setFilters((f) => ({
      ...f,
      types: new Set(data.types.map((t) => t.name).filter((t) => t !== "Type")),
      kinds: new Set(data.edgeKinds.map((k) => k.kind).filter((k) => k !== "body")),
    }));
    setInitialised(true);
  }, [data, initialised]);

  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [layoutRunning, setLayoutRunning] = useState(false);
  // A restored map needs no layout; new notes get a short settling run with everything else pinned.
  const layoutPins = useMemo(() => {
    if (!built || !built.restored || built.fresh.length === 0) return null;
    const fresh = new Set(built.fresh);
    return new Set(built.graph.nodes().filter((n) => !fresh.has(n)));
  }, [built]);
  useEffect(() => {
    if (!built) return;
    if (!built.restored || built.fresh.length > 0) setLayoutRunning(true);
  }, [built]);
  const onLayoutStopped = (positions: Positions) => {
    latestPositions.current = positions;
    if (graph) for (const [id, [x, y]] of Object.entries(positions)) if (graph.hasNode(id)) graph.mergeNodeAttributes(id, { x, y });
    setLayoutRunning(false);
    void saved.save(positions);
  };
  const resetLayout = async () => {
    setLayoutRunning(false);
    await saved.reset();
    latestPositions.current = null;
    setSeed((s) => ({ positions: null, nonce: (s?.nonce ?? 0) + 1 }));
  };
  const [focusRequest, setFocusRequest] = useState<{ node: string; nonce: number } | null>(null);
  const [fitRequest, setFitRequest] = useState(0);
  const [query, setQuery] = useState("");

  // Visible edge kinds are applied by hiding edges of other kinds: we model that by rebuilding
  // the "effective" graph degree per node for the orphan filter, and by hiding edges in GraphView
  // through node hiding only. Edge-kind hiding uses a filtered graph copy.
  const filteredGraph = useMemo(() => {
    if (!graph || !data) return null;
    const g = graph.copy();
    g.forEachEdge((e, a) => {
      if (!filters.kinds.has(a.kind)) g.dropEdge(e);
    });
    return g;
  }, [graph, data, filters.kinds]);

  const hidden = useMemo(() => {
    const set = new Set<string>();
    if (!filteredGraph || !data) return set;
    for (const n of data.nodes) {
      const t = n.type ?? "(untyped)";
      if (!filters.types.has(t)) set.add(n.id);
      else if (filters.hideArchived && n.archived) set.add(n.id);
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
  }, [filteredGraph, data, filters, selected]);

  const matches = useMemo(() => {
    if (!data || query.trim().length < 2) return [];
    const q = query.trim().toLowerCase();
    return data.nodes
      .filter((n) => n.title.toLowerCase().includes(q) || n.id.toLowerCase().includes(q))
      .sort((a, b) => (a.title.toLowerCase().startsWith(q) ? -1 : 1) - (b.title.toLowerCase().startsWith(q) ? -1 : 1) || b.inDegree - a.inDegree)
      .slice(0, 12);
  }, [data, query]);

  const select = (id: string | null, center = false) => {
    setSelected(id);
    if (id && center) setFocusRequest({ node: id, nonce: Date.now() });
  };

  if (error) return <div className="status error">Could not load the vault graph: {error}</div>;
  if (!data || !graph || !filteredGraph) return <div className="status">Parsing vault…</div>;

  const hoveredNode = hovered ? byId.get(hovered) : null;
  const selectedNode = selected ? byId.get(selected) : null;
  const visibleCount = data.nodes.length - hidden.size;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <strong>{data.vault.label}</strong>
          <span className="muted">
            {visibleCount}/{data.nodes.length} notes · {filteredGraph.size} links
            {saved.layout && !layoutRunning && ` · layout saved ${new Date(saved.layout.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
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
          <button className="button" onClick={() => setLayoutRunning((r) => !r)}>
            {layoutRunning ? "⏸ Pause layout" : "▶ Run layout"}
          </button>
          <button className="button" onClick={() => setFitRequest((n) => n + 1)}>Fit</button>
          <button className="button" onClick={resetLayout} title="Forget saved positions and compute a fresh layout">Reset layout</button>
          <button className="button" onClick={reload} title={`Parsed ${new Date(data.generatedAt).toLocaleTimeString()}`}>↻</button>
          <button className="button" onClick={theme.toggle} title="Toggle theme">{theme.dark ? "☀" : "☾"}</button>
        </div>
      </header>

      <Sidebar
        types={data.types}
        typeColors={typeColors}
        edgeKinds={data.edgeKinds}
        filters={filters}
        onChange={setFilters}
        hasSelection={!!selected}
      />

      <main className="stage">
        <GraphView
          key={theme.dark ? "dark" : "light"}
          graph={filteredGraph}
          hidden={hidden}
          selected={selected}
          layoutRunning={layoutRunning}
          theme={theme.graph}
          onHover={(node, pos) => {
            if (node !== undefined) setHovered(node);
            if (pos) setPointer(pos);
          }}
          onSelect={(id) => select(id)}
          layoutPins={layoutPins}
          layoutDuration={layoutPins ? 5000 : 12000}
          onLayoutStopped={onLayoutStopped}
          focusRequest={focusRequest}
          fitRequest={fitRequest}
        />
        {hoveredNode && pointer && (
          <div className="tooltip" style={{ left: pointer.x + 14, top: pointer.y + 14 }}>
            <div className="type-chip" style={{ background: typeColors.get(hoveredNode.type ?? "(untyped)") }}>{hoveredNode.type ?? "untyped"}</div>
            <strong>{hoveredNode.title}</strong>
            <div className="muted small">
              {hoveredNode.status ?? "—"} · {hoveredNode.inDegree} in · {hoveredNode.outDegree} out
            </div>
            {hoveredNode.summary && <p>{hoveredNode.summary}</p>}
          </div>
        )}
      </main>

      {selectedNode && (
        <NotePanel data={data} graph={filteredGraph} node={selectedNode} typeColors={typeColors} onSelect={(id) => select(id, true)} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
