import { useEffect, useRef } from "react";
import Sigma from "sigma";
import { createActivityLayer } from "../graph/activity";
import { sdfCircle, sdfDiamond, sdfRectangle, sdfSquare, sdfTriangle } from "sigma/rendering";
import { drawOnCanvas } from "@sigma/export-image";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { MAP_EXTENT, collectPositions, normalizePositions, placeSatellites, robustExtent, type BrainGraph, type EdgeAttrs, type LayoutSettings, type NodeAttrs, type Positions } from "../graph/build";
import { edgeStyle } from "../graph/colors";
import { clearHulls, drawHulls, type HullOptions } from "../graph/hulls";

export interface GraphViewProps {
  graph: BrainGraph;
  hidden: Set<string>; // node ids hidden by filters
  selected: string | null;
  layoutRunning: boolean;
  /** Notes placed while the graph was built, with where they were shown before: they glide from there once. */
  arrivals: Map<string, { x: number; y: number }> | null;
  /** Milliseconds before the layout stops by itself. */
  layoutDuration: number;
  /** Initial ForceAtlas2 slowDown: ~8 from scratch, ~16 to nudge an existing map. */
  layoutStart: number;
  /** Cap on a node's displacement per frame at the start of the run (graph units). */
  layoutMaxStep: number;
  /** ForceAtlas2 iterations per animation frame. */
  layoutIterations: number;
  /** User-tunable physics. */
  layoutSettings: LayoutSettings;
  theme: { background: string; label: string; labelHalo: string };
  /** Tinted group hulls behind the graph; null disables the layer. */
  hulls: Omit<HullOptions, "dim" | "halo"> | null;
  /** Show note labels for all nodes (density-managed); otherwise only on hover / selection. */
  showLabels: boolean;
  /** Base opacity of links (0.1–1). */
  linkOpacity: number;
  /** Link width multiplier. */
  linkWidth: number;
  /** Pulse notes reported as read or written by other apps. */
  showActivity: boolean;
  /** Rendered node size from which labels are drawn (zoom-dependent label density). */
  labelThreshold: number;
  /** Notes to keep highlighted (everything else fades) while nothing is hovered or selected. */
  spotlight: Set<string> | null;
  /** Focused group whose name is always drawn. */
  emphasisHub?: string | null;
  onHover: (node: string | null, pos: { x: number; y: number } | null) => void;
  onSelect: (node: string | null) => void;
  /** Positions at the end of a run, with the slug of the vault the graph belongs to (a run may end while another vault is loading). */
  onLayoutStopped: (positions: Positions, vault: string) => void;
  /** Progress of the current layout run, 0..1. */
  onLayoutProgress?: (progress: number) => void;
  focusRequest: { node: string; nonce: number } | null;
  fitRequest: number;
  /** Export request: a change triggers a PNG download of the current view. */
  exportRequest: number;
  onExported?: (ok: boolean, message?: string) => void;
  /** Camera state shared across renderer instances (theme switches remount the view). */
  cameraStore: React.MutableRefObject<{ x: number; y: number; ratio: number; angle: number } | null>;
}

type GS = { focusActive: boolean; labelsAlways: boolean; linkOpacity: number; linkWidth: number };

// ForceAtlas2 never "finishes": nodes keep jittering around their equilibrium, and its adaptive
// global speed defeats any damping applied to the positions it returns. So instead of the worker
// supervisor we step the synchronous layout a few iterations per animation frame (about 3 ms each
// for a thousand-note vault). Each call starts from a fresh speed state, which makes `slowDown` a direct lever
// on the step size: the run goes at full speed first, then slowDown grows exponentially and motion
// dies out before the time box ends.
const COOL_FACTOR = 400; // slowDown multiplier reached at the end of the run
// The run starts already damped (`start` slowDown, chosen by the caller: lower when laying out
// from scratch, higher when nudging an existing map) and cools from the first frame, so there is
// no fast "shaking" phase. Displacement per second is step size x iterations per second, so the
// iteration rate also drops from two per frame to one.
// Besides the exponential damping, each node's displacement per frame is capped (`maxStep`, in graph
// units, shrinking with progress), which removes the jumpy first frames when forces are large.
function scheduleAt(progress: number, start: number, maxStep: number, iterations: number): { slowDown: number; iterations: number; maxStep: number } {
  // Iterations taper to one per frame in the last stretch so the end is quiet.
  return { slowDown: start * COOL_FACTOR ** progress ** 1.2, iterations: progress < 0.7 ? iterations : 1, maxStep: maxStep * (1 - progress) ** 1.5 + 0.02 };
}

interface LayoutRunner {
  settings: ReturnType<typeof forceAtlas2.inferSettings>;
  iterations: number;
  /** Maximum displacement of a node per frame, as a fraction of the current map span (Infinity = uncapped). */
  maxStep: number;
  /** Called after each frame with the current robust extent, so the frame can follow the map's natural scale. */
  start(): void;
  stop(): void;
  isRunning(): boolean;
  kill(): void;
}

function createLayoutRunner(graph: BrainGraph): LayoutRunner {
  let frame: number | null = null;
  let running = false;
  const before = new Map<string, [number, number]>();
  const runner: LayoutRunner = {
    iterations: 1,
    maxStep: Infinity,
    settings: {
      ...forceAtlas2.inferSettings(graph),
      gravity: 1,
      scalingRatio: 10,
      strongGravityMode: true,
      slowDown: 10,
      barnesHutOptimize: true,
      barnesHutTheta: 0.6,
      adjustSizes: false,
      edgeWeightInfluence: 1,
    },
    start() {
      if (running) return;
      running = true;
      // The physics steps on its own copy at its natural scale (normalising the simulated positions
      // every frame fights ForceAtlas2 and collapses the map); the displayed graph gets a normalised
      // copy each frame, so the frame and the on-screen node sizes never change during a run.
      const sim = graph.copy();
      sim.forEachNode((n, a) => {
        if (a.ghost || a.bridge) sim.dropNode(n);
      });
      const step = () => {
        if (!running) return;
        const cap = runner.maxStep;
        if (Number.isFinite(cap)) {
          before.clear();
          sim.forEachNode((n, a) => before.set(n, [a.x, a.y]));
        }
        forceAtlas2.assign(sim, { iterations: runner.iterations, settings: runner.settings, getEdgeWeight: "weight" });
        // Cap each node's displacement relative to the physics' own scale.
        const extent = robustExtent(sim);
        if (Number.isFinite(cap) && extent) {
          const capUnits = cap * extent.span;
          sim.updateEachNodeAttributes(
            (n, a) => {
              const b = before.get(n);
              if (!b) return a;
              const dx = a.x - b[0];
              const dy = a.y - b[1];
              const d = Math.hypot(dx, dy);
              if (d <= capUnits) return a;
              const k = capUnits / d;
              return { ...a, x: b[0] + dx * k, y: b[1] + dy * k };
            },
            { attributes: ["x", "y"] },
          );
        }
        graph.updateEachNodeAttributes((n, a) => (sim.hasNode(n) ? { ...a, x: sim.getNodeAttribute(n, "x"), y: sim.getNodeAttribute(n, "y") } : a), { attributes: ["x", "y"] });
        normalizePositions(graph);
        placeSatellites(graph);
        frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    },
    stop() {
      running = false;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    },
    isRunning: () => running,
    kill() {
      runner.stop();
    },
  };
  return runner;
}

const played = new WeakSet<object>();
const GLIDE_MS = 900;

/**
 * Move the given notes from their previous spot to their new one with an ease-out, everything else still.
 * Their ghost and bridge satellites follow. `finish()` puts them at the end point at once; a glide cut
 * short that way counts as not played, so the next renderer of the same build (the view remounts in
 * React's development mode, or after a theme switch) plays it again.
 */
function playArrivals(graph: BrainGraph, arrivals: Map<string, { x: number; y: number }> | null): { finish: () => void } {
  const moves: [string, number, number, number, number][] = [];
  if (arrivals && arrivals.size && !played.has(arrivals)) {
    for (const [n, from] of arrivals) {
      if (!graph.hasNode(n)) continue;
      const { x, y } = graph.getNodeAttributes(n);
      if (Math.hypot(x - from.x, y - from.y) > 0.5) moves.push([n, from.x, from.y, x, y]);
    }
  }
  let frame: number | null = null;
  const set = (t: number) => {
    const k = 1 - Math.pow(1 - t, 3);
    for (const [n, x0, y0, x1, y1] of moves) graph.mergeNodeAttributes(n, { x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k });
    placeSatellites(graph);
  };
  if (moves.length) {
    set(0);
    // The clock starts at the first frame: building a large map takes most of a glide's length.
    let start: number | null = null;
    const step = (now: number) => {
      start ??= now;
      const t = Math.min(1, (now - start) / GLIDE_MS);
      set(t);
      frame = t < 1 ? requestAnimationFrame(step) : null;
      if (t >= 1) played.add(arrivals!);
    };
    frame = requestAnimationFrame(step);
  }
  return {
    finish() {
      if (frame === null) return;
      cancelAnimationFrame(frame);
      frame = null;
      set(1);
    },
  };
}

type NS = { isSelected: boolean };
type Helpers = {
  __highlight: (n: string) => void;
  __clear: () => void;
  __fit: () => void;
  /** Re-apply whatever should be lit when nothing is hovered: the selection, else the spotlight, else nothing. */
  __restore: () => void;
  /** Render the current view (background, regions, graph, names) to a PNG blob at `scale` × the screen pixels. */
  __exportPng: (scale: number) => Promise<Blob>;
};

export function GraphView(props: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma<NodeAttrs, EdgeAttrs, Record<string, unknown>, NS, {}, GS> | null>(null);
  const layoutRef = useRef<LayoutRunner | null>(null);
  const highlightedRef = useRef<{ nodes: string[]; edges: string[] }>({ nodes: [], edges: [] });
  const propsRef = useRef(props);
  propsRef.current = props;
  const selectedRef = useRef<string | null>(null);
  const handledFocus = useRef<number>(0);
  const handledFit = useRef<number>(0);

  // Create the renderer once per graph instance.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const { graph, theme } = propsRef.current;

    const sigma = new Sigma<NodeAttrs, EdgeAttrs, Record<string, unknown>, NS, {}, GS>(graph, container, {
      customGraphState: { focusActive: false, labelsAlways: propsRef.current.showLabels, linkOpacity: propsRef.current.linkOpacity, linkWidth: propsRef.current.linkWidth },
      // Sigma only registers the circle by default; declare the shapes used for note types.
      primitives: { nodes: { shapes: [sdfCircle(), sdfSquare(), sdfDiamond(), sdfTriangle(), sdfRectangle()] } },
      customNodeState: { isSelected: false },
      settings: {
        allowInvalidContainer: true, // the pane may be hidden (0x0) on first mount; we resize below
        labelRenderedSizeThreshold: 7,
        labelDensity: 0.5,
        labelGridCellSize: 90,
        hideEdgesOnMove: false,
        enableEdgeEvents: false,
        zoomingRatio: 1.4,
        minCameraRatio: 0.02,
        maxCameraRatio: 3,
        enableNodeDrag: false,
      },
      styles: {
        stage: { background: "rgba(0,0,0,0)" }, // the container paints the background so layers behind the stage show
        nodes: [
          {
            x: { attribute: "x" },
            y: { attribute: "y" },
            color: { attribute: "color" },
            shape: { attribute: "shape", defaultValue: "circle" },
            opacity: { attribute: "recency", defaultValue: 1 },
            label: { attribute: "label" },
            size: { whenState: "isHovered", then: (a) => a.size * 1.35, else: { attribute: "size" } },
            labelColor: theme.label,
            labelSize: 12,
            labelFont: "Inter, system-ui, sans-serif",
            labelVisibility: {
              whenState: "isHovered",
              then: "visible",
              else: { when: (_a, _s, gs) => gs.labelsAlways, then: "auto", else: "hidden" },
            },
            depth: { whenState: "isHovered", then: "topNodes", else: "nodes" },
            backdropVisibility: { whenState: "isHovered", then: "visible", else: "hidden" },
            backdropColor: theme.labelHalo,
            backdropShadowColor: "rgba(0,0,0,0.45)",
            backdropShadowBlur: 10,
            backdropPadding: 5,
            backdropCornerRadius: 6,
            cursor: "pointer",
          },
          {
            when: (_a, s, gs) => gs.focusActive && !s.isHighlighted && !s.isHovered,
            then: { opacity: 0.08, labelVisibility: "hidden" },
          },
          { whenState: "isHighlighted", then: { labelVisibility: "auto", depth: "topNodes" } },
          { when: (_a, s, gs) => gs.labelsAlways && gs.focusActive && !s.isHighlighted && !s.isHovered, then: { labelVisibility: "hidden" } },
          { whenState: "isSelected", then: { labelVisibility: "visible", size: (a) => a.size * 1.5, depth: "topNodes", backdropVisibility: "visible" } },
          { whenState: "isHidden", then: { visibility: "hidden" } },
        ],
        edges: [
          {
            path: "straight",
            color: (a) => edgeStyle(a.kind).color,
            // Width and opacity follow the link's visual weight (lateral links fade as the ratio grows) and the global link opacity.
            size: (a, _s, gs) => edgeStyle(a.kind).width * gs.linkWidth * Math.max(0.35, a.emphasis ?? 1),
            head: (a) => (edgeStyle(a.kind).directed ? "arrow" : "none"),
            opacity: (a, _s, gs) => gs.linkOpacity * (a.emphasis ?? 1),
          },
          { when: (_a, s, gs) => gs.focusActive && !s.isHighlighted, then: { opacity: 0.02 } },
          { whenState: "isHighlighted", then: { opacity: 1, depth: "topEdges", size: (a, _s, gs) => edgeStyle(a.kind).width * gs.linkWidth * Math.max(0.5, a.emphasis ?? 1) + 0.8 } },
          { whenState: "isHidden", then: { visibility: "hidden" } },
        ],
      },
    });
    sigmaRef.current = sigma;
    container.style.background = theme.background;
    // Hull layer behind the WebGL stage, redrawn after every Sigma render.
    const hullBack = sigma.createCanvas("hulls", { beforeLayer: "stage", style: { pointerEvents: "none" } });
    const hullFront = sigma.createCanvas("hull-labels", { afterLayer: "stage", style: { pointerEvents: "none" } });
    // Notes read or written by other apps pulse on their own layer.
    const activity = createActivityLayer(sigma as unknown as Sigma, graph, sigma.createCanvas("activity", { afterLayer: "stage", style: { pointerEvents: "none" } }));
    const onActivity = (e: Event) => {
      const a = (e as CustomEvent<{ vault: string; id: string; kind: "read" | "write" }>).detail;
      if (propsRef.current.showActivity && a.vault === graph.getAttribute("vault")) activity.pulse(a.id, a.kind);
    };
    window.addEventListener("brain-graph-activity", onActivity);
    const redrawHulls = () => {
      const h = propsRef.current.hulls;
      if (!h) return clearHulls(hullBack, hullFront);
      drawHulls(sigma as unknown as Sigma, graph, hullBack, hullFront, {
        ...h,
        halo: propsRef.current.theme.background,
        dim: sigma.getGraphState().focusActive,
        quiet: propsRef.current.showLabels, // note labels are on: group names step back
        emphasis: propsRef.current.emphasisHub ?? null,
      });
    };
    sigma.on("afterRender", redrawHulls);
    (sigma as unknown as { __redrawHulls: () => void }).__redrawHulls = redrawHulls;
    // Keep the viewpoint when the graph is swapped (relationship filters rebuild it).
    if (propsRef.current.cameraStore.current) sigma.getCamera().setState(propsRef.current.cameraStore.current);
    if (import.meta.env.DEV) (window as unknown as { __sigma: unknown }).__sigma = sigma;

    const clearHighlight = () => {
      const h = highlightedRef.current;
      if (h.nodes.length) sigma.setNodesState(h.nodes, { isHighlighted: false });
      if (h.edges.length) sigma.setEdgesState(h.edges, { isHighlighted: false });
      highlightedRef.current = { nodes: [], edges: [] };
      sigma.setGraphState({ focusActive: false });
    };
    const highlight = (node: string) => {
      clearHighlight();
      const { hidden } = propsRef.current;
      const nodes = [node];
      const edges: string[] = [];
      graph.forEachEdge(node, (edge, _attrs, source, target) => {
        const other = source === node ? target : source;
        if (hidden.has(other)) return;
        edges.push(edge);
        nodes.push(other);
      });
      sigma.setNodesState(nodes, { isHighlighted: true });
      sigma.setEdgesState(edges, { isHighlighted: true });
      highlightedRef.current = { nodes, edges };
      sigma.setGraphState({ focusActive: true });
    };

    const spotlightAll = (set: Set<string>) => {
      clearHighlight();
      const nodes = [...set].filter((n) => graph.hasNode(n));
      const edges: string[] = [];
      graph.forEachEdge((edge, _a, source, target) => {
        if (set.has(source) && set.has(target)) edges.push(edge);
      });
      sigma.setNodesState(nodes, { isHighlighted: true });
      sigma.setEdgesState(edges, { isHighlighted: true });
      highlightedRef.current = { nodes, edges };
      sigma.setGraphState({ focusActive: true });
    };
    const restore = () => {
      const { selected, spotlight } = propsRef.current;
      if (spotlight) spotlightAll(spotlight);
      else if (selected && graph.hasNode(selected)) highlight(selected);
      else clearHighlight();
    };
    sigma.on("enterNode", ({ node, event }) => {
      highlight(node);
      propsRef.current.onHover(node, { x: event.x, y: event.y });
    });
    sigma.on("leaveNode", () => {
      restore();
      propsRef.current.onHover(null, null);
    });
    sigma.on("clickNode", ({ node }) => propsRef.current.onSelect(node));
    sigma.on("clickStage", () => propsRef.current.onSelect(null));
    const onMove = (e: MouseEvent) => {
      const r = container.getBoundingClientRect();
      propsRef.current.onHover(undefined as unknown as null, { x: e.clientX - r.left, y: e.clientY - r.top });
    };
    container.addEventListener("mousemove", onMove);
    const ro = new ResizeObserver(() => {
      if (container.clientWidth > 0 && container.clientHeight > 0) {
        sigma.resize();
        sigma.scheduleRefresh();
      }
    });
    ro.observe(container);

    const layout = createLayoutRunner(graph);
    if (import.meta.env.DEV) Object.assign(window as unknown as Record<string, unknown>, { __layout: layout, __fa2: forceAtlas2, __graph: graph });
    layoutRef.current = layout;

    // The displayed map is normalised to MAP_EXTENT around 0 on every layout frame, so the frame is fixed once:
    // nothing ever refits, node sizes stay constant, and "Fit" is just a smooth camera move.
    const half = MAP_EXTENT / 2 + MAP_EXTENT * 0.06;
    const fixedFrame = () => sigma.setCustomBBox({ x: [-half, half], y: [-half, half] });
    fixedFrame();
    const fitToVisible = fixedFrame;
    // The frame stays fixed during runs too: Sigma scales node sizes with the frame, so a frame that
    // followed the map made every node shrink during a run and snap back at its end.

    // Expose the helpers to the effects below through the instance.
    const ext = sigma as unknown as Helpers;
    ext.__highlight = highlight;
    ext.__clear = clearHighlight;
    ext.__fit = fitToVisible;
    ext.__restore = restore;
    ext.__exportPng = async (scale: number) => {
      const { width, height } = sigma.getDimensions();
      const dpr = (window.devicePixelRatio || 1) * scale;
      const out = document.createElement("canvas");
      out.width = Math.round(width * dpr);
      out.height = Math.round(height * dpr);
      const ctx = out.getContext("2d")!;
      ctx.fillStyle = propsRef.current.theme.background;
      ctx.fillRect(0, 0, out.width, out.height);
      // Regions and names are redrawn at export resolution on scratch canvases.
      const h = propsRef.current.hulls;
      const back = document.createElement("canvas");
      const front = document.createElement("canvas");
      if (h) {
        const fakeDims = { getDimensions: () => ({ width, height }) };
        const proxy = new Proxy(sigma as unknown as Record<string, unknown>, {
          get: (t, k) => (k in fakeDims ? (fakeDims as Record<string, unknown>)[k as string] : (t as Record<string, unknown>)[k as string]),
        }) as unknown as Sigma;
        const saved = window.devicePixelRatio;
        Object.defineProperty(window, "devicePixelRatio", { value: dpr, configurable: true });
        try {
          drawHulls(proxy, graph, back, front, { ...h, halo: propsRef.current.theme.background, dim: false, quiet: propsRef.current.showLabels, emphasis: propsRef.current.emphasisHub ?? null });
        } finally {
          Object.defineProperty(window, "devicePixelRatio", { value: saved, configurable: true });
        }
        ctx.drawImage(back, 0, 0, out.width, out.height);
      }
      // The graph itself: a temporary renderer at export resolution, same camera and styles.
      const graphCanvas = await drawOnCanvas(sigma as unknown as Sigma, {
        width: out.width,
        height: out.height,
        backgroundColor: "rgba(0,0,0,0)",
        sigmaOverrides: {
          settings: (st) => ({ ...st, labelRenderedSizeThreshold: (st.labelRenderedSizeThreshold ?? 7) * scale }),
        },
      });
      ctx.drawImage(graphCanvas, 0, 0, out.width, out.height);
      if (h) ctx.drawImage(front, 0, 0, out.width, out.height);
      return new Promise<Blob>((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"));
    };

    // Notes placed on a reload glide to their spot, once per build (a filter change copies the graph again).
    const glide = playArrivals(graph, propsRef.current.arrivals);

    return () => {
      glide.finish();
      window.removeEventListener("brain-graph-activity", onActivity);
      activity.stop();
      container.removeEventListener("mousemove", onMove);
      ro.disconnect();
      propsRef.current.cameraStore.current = sigma.getCamera().getState();
      layout.kill();
      sigma.kill();
      sigmaRef.current = null;
      layoutRef.current = null;
    };
  }, [props.graph]);

  // Layout start/stop, with an automatic stop so the graph settles.
  useEffect(() => {
    const layout = layoutRef.current;
    if (!layout) return;
    const fit = () => (sigmaRef.current as unknown as Helpers | null)?.__fit();
    const { graph, layoutDuration, layoutStart, layoutMaxStep, layoutIterations, layoutSettings: ls } = props;
    const reset = () =>
      Object.assign(layout, {
        iterations: layoutIterations,
        maxStep: layoutMaxStep,
        settings: {
          ...layout.settings,
          slowDown: layoutStart,
          gravity: ls.gravity,
        },
      });
    const stop = () => {
      layout.stop();
      reset();
      normalizePositions(graph);
      fit();
      propsRef.current.onLayoutProgress?.(0);
      propsRef.current.onLayoutStopped(collectPositions(graph), String(graph.getAttribute("vault") ?? ""));
    };
    if (props.layoutRunning) {
      if (!layout.isRunning()) {
        reset();
        layout.start();
      }
      const started = performance.now();
      const tick = setInterval(() => {
        const progress = Math.min(1, (performance.now() - started) / layoutDuration);
        const sched = scheduleAt(progress, layoutStart, layoutMaxStep, layoutIterations);
        layout.settings.slowDown = sched.slowDown;
        layout.iterations = sched.iterations;
        layout.maxStep = sched.maxStep;
        propsRef.current.onLayoutProgress?.(progress);
      }, 250);
      const t = setTimeout(stop, layoutDuration);
      return () => {
        clearInterval(tick);
        clearTimeout(t);
        if (layout.isRunning()) stop();
      };
    }
    fit();
  }, [props.layoutRunning, props.graph]);

  // Apply filter visibility through node/edge state rather than mutating the graph.
  useEffect(() => {
    const sigma = sigmaRef.current;
    if (!sigma) return;
    const { graph, hidden } = props;
    const shown: string[] = [];
    const hid: string[] = [];
    graph.forEachNode((n) => (hidden.has(n) ? hid : shown).push(n));
    sigma.setNodesState(shown, { isHidden: false });
    sigma.setNodesState(hid, { isHidden: true });
    const eShown: string[] = [];
    const eHid: string[] = [];
    graph.forEachEdge((e, _a, s, t) => (hidden.has(s) || hidden.has(t) ? eHid : eShown).push(e));
    sigma.setEdgesState(eShown, { isHidden: false });
    sigma.setEdgesState(eHid, { isHidden: true });
    // Deliberately no camera refit here: filtering or isolating should not move the view.
  }, [props.hidden, props.graph]);

  // Keep the selected node's neighbourhood highlighted.
  useEffect(() => {
    const sigma = sigmaRef.current as unknown as Helpers | null;
    if (!sigma) return;
    const real = sigmaRef.current;
    if (!real) return;
    const prev = selectedRef.current;
    if (prev && props.graph.hasNode(prev)) real.setNodeState(prev, { isSelected: false });
    selectedRef.current = props.selected;
    if (props.selected && props.graph.hasNode(props.selected)) real.setNodeState(props.selected, { isSelected: true });
    sigma.__restore();
  }, [props.selected, props.graph, props.hidden, props.spotlight]);

  // Physics changed while a run is going: apply at once so the effect is visible immediately.
  useEffect(() => {
    const layout = layoutRef.current;
    if (!layout || !layout.isRunning()) return;
    const ls = props.layoutSettings;
    Object.assign(layout.settings, { gravity: ls.gravity });
  }, [props.layoutSettings]);

  // Label policy. The label grid is only rebuilt on render, so refresh explicitly. While all labels
  // are requested, or while a type / group is focused (its notes are the only lit ones), let more
  // labels through than the hover-only default allows.
  useEffect(() => {
    const sigma = sigmaRef.current;
    if (!sigma) return;
    const dense = props.showLabels || !!props.spotlight;
    sigma.setGraphState({ labelsAlways: props.showLabels, linkOpacity: props.linkOpacity, linkWidth: props.linkWidth });
    sigma.setSetting("labelDensity", dense ? 1.4 : 0.5);
    sigma.setSetting("labelRenderedSizeThreshold", dense ? props.labelThreshold * 0.45 : props.labelThreshold);
    sigma.refresh();
  }, [props.showLabels, props.spotlight, props.graph, props.linkOpacity, props.linkWidth, props.labelThreshold]);

  // Hull options changed (level, visibility, toggle): redraw without waiting for a camera move.
  useEffect(() => {
    (sigmaRef.current as unknown as { __redrawHulls?: () => void } | null)?.__redrawHulls?.();
  }, [props.hulls, props.hidden, props.graph, props.showLabels, props.emphasisHub]);

  // Camera: centre on a requested node.
  useEffect(() => {
    const sigma = sigmaRef.current;
    if (!sigma || !props.focusRequest || props.focusRequest.nonce === handledFocus.current) return;
    handledFocus.current = props.focusRequest.nonce;
    const { node } = props.focusRequest;
    if (!props.graph.hasNode(node)) return;
    // Keep the zoom as it is (like clicking on the graph); only pan when the node is off-screen.
    const a = props.graph.getNodeAttributes(node);
    const v = sigma.graphToViewport({ x: a.x, y: a.y });
    const { width, height } = sigma.getDimensions();
    const margin = 40;
    const visible = v.x > margin && v.x < width - margin && v.y > margin && v.y < height - margin;
    if (visible) return;
    const p = sigma.graphToFramedGraph({ x: a.x, y: a.y });
    void sigma.getCamera().animate({ x: p.x, y: p.y }, { duration: 400 });
  }, [props.focusRequest]);

  const handledExport = useRef(0);
  useEffect(() => {
    const sigma = sigmaRef.current as unknown as Helpers | null;
    if (!sigma || !props.exportRequest || props.exportRequest === handledExport.current) return;
    handledExport.current = props.exportRequest;
    sigma
      .__exportPng(2)
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
        a.download = `brain-graph-${propsRef.current.hulls?.data.vault.slug ?? "vault"}-${stamp}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        propsRef.current.onExported?.(true);
      })
      .catch((e) => propsRef.current.onExported?.(false, String(e)));
  }, [props.exportRequest]);

  useEffect(() => {
    const sigma = sigmaRef.current;
    if (!sigma || !props.fitRequest || props.fitRequest === handledFit.current) return;
    handledFit.current = props.fitRequest;
    void sigma.getCamera().animate({ x: 0.5, y: 0.5, ratio: 1, angle: 0 }, { duration: 500 });
  }, [props.fitRequest]);

  return <div ref={containerRef} className="graph-canvas" />;
}
