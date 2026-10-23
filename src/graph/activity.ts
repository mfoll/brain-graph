// Proof of concept: pulse notes on the map when another app reads or writes them (see server/activity.ts).
// A ripple marks the moment; a glow fades over half a minute so a session leaves a visible trail.
import type Sigma from "sigma";
import type { BrainGraph } from "./build";

type Kind = "read" | "write";
const RIPPLE_MS = 1600;
const GLOW_MS = 30_000;
const COLOURS: Record<Kind, string> = { read: "#3b82f6", write: "#e69f00" };

export function createActivityLayer(sigma: Sigma, graph: BrainGraph, canvas: HTMLCanvasElement) {
  const pulses = new Map<string, { t0: number; kind: Kind }>();
  let frame: number | null = null;

  const draw = () => {
    frame = null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { width, height } = sigma.getDimensions();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const now = performance.now();
    const sizeRatio = sigma.scaleSize(1);
    for (const [id, p] of pulses) {
      const age = now - p.t0;
      if (age > GLOW_MS || !graph.hasNode(id)) {
        pulses.delete(id);
        continue;
      }
      const a = graph.getNodeAttributes(id);
      const c = sigma.graphToViewport({ x: a.x, y: a.y });
      const r = Math.max(3, a.size * sizeRatio);
      const fade = 1 - age / GLOW_MS;
      ctx.fillStyle = COLOURS[p.kind];
      ctx.globalAlpha = 0.4 * fade * fade;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r + 6, 0, Math.PI * 2);
      ctx.fill();
      if (age < RIPPLE_MS) {
        const t = age / RIPPLE_MS;
        ctx.strokeStyle = COLOURS[p.kind];
        ctx.globalAlpha = 1 - t;
        ctx.lineWidth = p.kind === "write" ? 3 : 2;
        ctx.beginPath();
        ctx.arc(c.x, c.y, r + 4 + t * 28, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    if (pulses.size) frame = requestAnimationFrame(draw);
  };

  return {
    pulse(id: string, kind: Kind) {
      if (!graph.hasNode(id)) return;
      pulses.set(id, { t0: performance.now(), kind });
      if (frame === null) frame = requestAnimationFrame(draw);
    },
    stop() {
      if (frame !== null) cancelAnimationFrame(frame);
      pulses.clear();
    },
  };
}
