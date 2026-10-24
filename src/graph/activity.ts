// Pulse notes on the map when another app reads or writes them (see server/activity.ts).
// A ripple marks the moment; a glow fades over half a minute so a session leaves a visible trail.
import type Sigma from "sigma";
import type { BrainGraph } from "./build";

type Kind = "read" | "write";
const RIPPLE_MS = 1600;
const GLOW_MS = 30_000;
// Writes use pure red: the farthest colour from every group palette that still shows on both themes (the
// earlier orange was the Okabe–Ito palette's own orange, so writes vanished on orange groups).
const COLOURS: Record<Kind, string> = { read: "#3b82f6", write: "#ff0000" };

// Kept outside any one layer: a file change reloads the graph and recreates the layer, and the pulse that
// change caused must carry on.
const pulses = new Map<string, { t0: number; kind: Kind }>();

// Links an agent followed (graph/trails.ts): a dot runs from the note it came from to the note it read,
// then the link glows and fades. Few at a time, so a large burst stays readable.
const TRAVEL_MS = 600;
const TRAIL_MS = 12_000;
const MAX_TRAILS = 40;
const trails: { from: string; to: string; t0: number }[] = [];

/** `shown` says whether a note is drawn right now: filters hide notes but keep their positions, and a pulse
 * there would glow on an empty spot. It is asked on every frame, so a note hidden later stops glowing. */
export function createActivityLayer(sigma: Sigma, graph: BrainGraph, canvas: HTMLCanvasElement, shown: (id: string) => boolean) {
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
    // Trails first, so the notes' own glows sit on top of them.
    for (let i = trails.length - 1; i >= 0; i--) {
      const tr = trails[i];
      const age = now - tr.t0;
      if (age > TRAIL_MS) {
        trails.splice(i, 1);
        continue;
      }
      if (!graph.hasNode(tr.from) || !graph.hasNode(tr.to) || !shown(tr.from) || !shown(tr.to)) continue;
      const a = graph.getNodeAttributes(tr.from);
      const b = graph.getNodeAttributes(tr.to);
      const p = sigma.graphToViewport({ x: a.x, y: a.y });
      const q = sigma.graphToViewport({ x: b.x, y: b.y });
      const fade = 1 - age / TRAIL_MS;
      ctx.strokeStyle = COLOURS.read;
      ctx.lineCap = "round";
      // The link itself, drawn as far as the dot has gone.
      const reach = Math.min(1, age / TRAVEL_MS);
      const eased = 1 - Math.pow(1 - reach, 3);
      const hx = p.x + (q.x - p.x) * eased;
      const hy = p.y + (q.y - p.y) * eased;
      ctx.globalAlpha = 0.45 * fade * fade;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      if (reach < 1) {
        // The travelling dot, with a short bright tail behind it.
        const tail = Math.max(0, eased - 0.25);
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.moveTo(p.x + (q.x - p.x) * tail, p.y + (q.y - p.y) * tail);
        ctx.lineTo(hx, hy);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = COLOURS.read;
        ctx.beginPath();
        ctx.arc(hx, hy, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    for (const [id, p] of pulses) {
      const age = now - p.t0;
      if (age > GLOW_MS) {
        pulses.delete(id);
        continue;
      }
      if (!graph.hasNode(id) || !shown(id)) continue;
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
    if (pulses.size || trails.length) frame = requestAnimationFrame(draw);
  };

  if (pulses.size || trails.length) frame = requestAnimationFrame(draw);
  return {
    pulse(id: string, kind: Kind) {
      if (!graph.hasNode(id)) return;
      pulses.set(id, { t0: performance.now(), kind });
      if (frame === null) frame = requestAnimationFrame(draw);
    },
    /** A link followed from one note to another (both already resolved to the notes drawn on the map). */
    trail(from: string, to: string) {
      if (!graph.hasNode(from) || !graph.hasNode(to) || from === to) return;
      trails.push({ from, to, t0: performance.now() });
      if (trails.length > MAX_TRAILS) trails.splice(0, trails.length - MAX_TRAILS);
      if (frame === null) frame = requestAnimationFrame(draw);
    },
    stop() {
      if (frame !== null) cancelAnimationFrame(frame);
    },
  };
}
