import { useEffect, useRef } from "react";
import Sigma from "sigma";
import { sdfCircle, sdfDiamond, sdfSquare, sdfTriangle } from "sigma/rendering";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { collectPositions, type BrainGraph, type EdgeAttrs, type NodeAttrs, type Positions } from "../graph/build";
import { edgeStyle } from "../graph/colors";
import { clearHulls, drawHulls, type HullOptions } from "../graph/hulls";

export interface GraphViewProps {
  graph: BrainGraph;
  hidden: Set<string>; // node ids hidden by filters
  selected: string | null;
  layoutRunning: boolean;
  /** Nodes to keep fixed while the layout runs (settling only the new notes). */
  layoutPins: Set<string> | null;
  /** Milliseconds before the layout stops by itself. */
  layoutDuration: number;
  /** Initial ForceAtlas2 slowDown: ~8 from scratch, ~16 to nudge an existing map. */
  layoutStart: number;
  theme: { background: string; label: string; labelHalo: string };
  /** Tinted group hulls behind the graph; null disables the layer. */
  hulls: Omit<HullOptions, "dim" | "halo"> | null;
  /** Show note labels for all nodes (density-managed); otherwise only on hover / selection. */
  showLabels: boolean;
  /** Notes to keep highlighted (everything else fades) while nothing is hovered or selected. */
  spotlight: Set<string> | null;
  onHover: (node: string | null, pos: { x: number; y: number } | null) => void;
  onSelect: (node: string | null) => void;
  onLayoutStopped: (positions: Positions) => void;
  /** Progress of the current layout run, 0..1. */
  onLayoutProgress?: (progress: number) => void;
  focusRequest: { node: string; nonce: number } | null;
  fitRequest: number;
}

type GS = { focusActive: boolean; labelsAlways: boolean };

// ForceAtlas2 never "finishes": nodes keep jittering around their equilibrium, and its adaptive
// global speed defeats any damping applied to the positions it returns. So instead of the worker
// supervisor we step the synchronous layout a few iterations per animation frame (about 3 ms each
// for this vault). Each call starts from a fresh speed state, which makes `slowDown` a direct lever
// on the step size: the run goes at full speed first, then slowDown grows exponentially and motion
// dies out before the time box ends.
const COOL_FACTOR = 400; // slowDown multiplier reached at the end of the run
// The run starts already damped (`start` slowDown, chosen by the caller: lower when laying out
// from scratch, higher when nudging an existing map) and cools from the first frame, so there is
// no fast "shaking" phase. Displacement per second is step size x iterations per second, so the
// iteration rate also drops from two per frame to one.
function scheduleAt(progress: number, start: number): { slowDown: number; iterations: number } {
  return { slowDown: start * COOL_FACTOR ** progress ** 1.4, iterations: progress < 0.3 ? 2 : 1 };
}

interface LayoutRunner {
  settings: ReturnType<typeof forceAtlas2.inferSettings>;
  iterations: number;
  start(): void;
  stop(): void;
  isRunning(): boolean;
  kill(): void;
}

function createLayoutRunner(graph: BrainGraph): LayoutRunner {
  let frame: number | null = null;
  let running = false;
  const runner: LayoutRunner = {
    iterations: 2,
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
      const step = () => {
        if (!running) return;
        forceAtlas2.assign(graph, { iterations: runner.iterations, settings: runner.settings, getEdgeWeight: "weight" });
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

type NS = { isSelected: boolean };
type Helpers = {
  __highlight: (n: string) => void;
  __clear: () => void;
  __fit: () => void;
  /** Re-apply whatever should be lit when nothing is hovered: the selection, else the spotlight, else nothing. */
  __restore: () => void;
};

export function GraphView(props: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma<NodeAttrs, EdgeAttrs, Record<string, unknown>, NS, {}, GS> | null>(null);
  const layoutRef = useRef<LayoutRunner | null>(null);
  const highlightedRef = useRef<{ nodes: string[]; edges: string[] }>({ nodes: [], edges: [] });
  const propsRef = useRef(props);
  propsRef.current = props;
  const selectedRef = useRef<string | null>(null);
  const cameraRef = useRef<{ x: number; y: number; ratio: number; angle: number } | null>(null);
  const handledFocus = useRef<number>(0);
  const handledFit = useRef<number>(0);

  // Create the renderer once per graph instance.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const { graph, theme } = propsRef.current;

    const sigma = new Sigma<NodeAttrs, EdgeAttrs, Record<string, unknown>, NS, {}, GS>(graph, container, {
      customGraphState: { focusActive: false, labelsAlways: propsRef.current.showLabels },
      // Sigma only registers the circle by default; declare the shapes used for note types.
      primitives: { nodes: { shapes: [sdfCircle(), sdfSquare(), sdfDiamond(), sdfTriangle()] } },
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
            size: (a) => edgeStyle(a.kind).width,
            head: (a) => (edgeStyle(a.kind).directed ? "arrow" : "none"),
            opacity: 0.55,
          },
          { when: (_a, s, gs) => gs.focusActive && !s.isHighlighted, then: { opacity: 0.02 } },
          { whenState: "isHighlighted", then: { opacity: 1, depth: "topEdges", size: (a) => edgeStyle(a.kind).width + 0.8 } },
          { whenState: "isHidden", then: { visibility: "hidden" } },
        ],
      },
    });
    sigmaRef.current = sigma;
    container.style.background = theme.background;
    // Hull layer behind the WebGL stage, redrawn after every Sigma render.
    const hullBack = sigma.createCanvas("hulls", { beforeLayer: "stage", style: { pointerEvents: "none" } });
    const hullFront = sigma.createCanvas("hull-labels", { afterLayer: "stage", style: { pointerEvents: "none" } });
    const redrawHulls = () => {
      const h = propsRef.current.hulls;
      if (!h) return clearHulls(hullBack, hullFront);
      drawHulls(sigma as unknown as Sigma, graph, hullBack, hullFront, {
        ...h,
        halo: propsRef.current.theme.background,
        dim: sigma.getGraphState().focusActive,
        quiet: propsRef.current.showLabels, // note labels are on: group names step back
      });
    };
    sigma.on("afterRender", redrawHulls);
    (sigma as unknown as { __redrawHulls: () => void }).__redrawHulls = redrawHulls;
    // Keep the viewpoint when the graph is swapped (relationship filters rebuild it).
    if (cameraRef.current) sigma.getCamera().setState(cameraRef.current);
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
      if (selected && graph.hasNode(selected)) highlight(selected);
      else if (spotlight) spotlightAll(spotlight);
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

    // Fit the camera's reference frame to the visible nodes only, so hidden or far-flung
    // orphans do not shrink the interesting part of the graph into a dot.
    const fitToVisible = () => {
      const { hidden } = propsRef.current;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, n = 0;
      graph.forEachNode((node, a) => {
        if (hidden.has(node)) return;
        n++;
        if (a.x < minX) minX = a.x;
        if (a.x > maxX) maxX = a.x;
        if (a.y < minY) minY = a.y;
        if (a.y > maxY) maxY = a.y;
      });
      if (n < 2) return sigma.setCustomBBox(null);
      const padX = (maxX - minX) * 0.05 || 1;
      const padY = (maxY - minY) * 0.05 || 1;
      sigma.setCustomBBox({ x: [minX - padX, maxX + padX], y: [minY - padY, maxY + padY] });
      sigma.scheduleRefresh();
    };

    // Expose the helpers to the effects below through the instance.
    const ext = sigma as unknown as Helpers;
    ext.__highlight = highlight;
    ext.__clear = clearHighlight;
    ext.__fit = fitToVisible;
    ext.__restore = restore;

    return () => {
      container.removeEventListener("mousemove", onMove);
      ro.disconnect();
      cameraRef.current = sigma.getCamera().getState();
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
    const { graph, layoutPins, layoutDuration, layoutStart } = props;
    const reset = () => Object.assign(layout, { iterations: 2, settings: { ...layout.settings, slowDown: layoutStart } });
    const stop = () => {
      layout.stop();
      reset();
      if (layoutPins) graph.forEachNode((n) => graph.removeNodeAttribute(n, "fixed"));
      fit();
      propsRef.current.onLayoutProgress?.(0);
      propsRef.current.onLayoutStopped(collectPositions(graph));
    };
    if (props.layoutRunning) {
      if (!layout.isRunning()) {
        // FA2 reads the `fixed` attribute on every step, so pin before starting.
        if (layoutPins) graph.forEachNode((n) => graph.setNodeAttribute(n, "fixed", layoutPins.has(n)));
        reset();
        layout.start();
      }
      const started = performance.now();
      const tick = setInterval(() => {
        const progress = Math.min(1, (performance.now() - started) / layoutDuration);
        const sched = scheduleAt(progress, layoutStart);
        layout.settings.slowDown = sched.slowDown;
        layout.iterations = sched.iterations;
        propsRef.current.onLayoutProgress?.(progress);
        fit();
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

  // Label policy. The label grid is only rebuilt on render, so refresh explicitly. While all labels
  // are requested, or while a type / group is focused (its notes are the only lit ones), let more
  // labels through than the hover-only default allows.
  useEffect(() => {
    const sigma = sigmaRef.current;
    if (!sigma) return;
    const dense = props.showLabels || !!props.spotlight;
    sigma.setGraphState({ labelsAlways: props.showLabels });
    sigma.setSetting("labelDensity", dense ? 1.4 : 0.5);
    sigma.setSetting("labelRenderedSizeThreshold", dense ? 3 : 7);
    sigma.refresh();
  }, [props.showLabels, props.spotlight, props.graph]);

  // Hull options changed (level, visibility, toggle): redraw without waiting for a camera move.
  useEffect(() => {
    (sigmaRef.current as unknown as { __redrawHulls?: () => void } | null)?.__redrawHulls?.();
  }, [props.hulls, props.hidden, props.graph, props.showLabels]);

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

  useEffect(() => {
    const sigma = sigmaRef.current;
    if (!sigma || !props.fitRequest || props.fitRequest === handledFit.current) return;
    handledFit.current = props.fitRequest;
    (sigma as unknown as Helpers).__fit();
    void sigma.getCamera().animate({ x: 0.5, y: 0.5, ratio: 1, angle: 0 }, { duration: 450 });
  }, [props.fitRequest]);

  return <div ref={containerRef} className="graph-canvas" />;
}
