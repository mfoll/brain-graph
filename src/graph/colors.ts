// Tolaria lets a Type note carry either a hex value or a named color in `_color`/`color`.
const NAMED: Record<string, string> = {
  red: "#ef4444", orange: "#f97316", amber: "#f59e0b", yellow: "#eab308", lime: "#84cc16",
  green: "#22c55e", emerald: "#10b981", teal: "#14b8a6", cyan: "#06b6d4", sky: "#0ea5e9",
  blue: "#3b82f6", indigo: "#6366f1", violet: "#8b5cf6", purple: "#a855f7", fuchsia: "#d946ef",
  pink: "#ec4899", rose: "#f43f5e", gray: "#9ca3af", grey: "#9ca3af", slate: "#94a3b8", stone: "#a8a29e",
};

// Fallback palette for Types that declare no color (distinct from the Tailwind-ish named set above).
const FALLBACK = ["#c084fc", "#fb7185", "#34d399", "#60a5fa", "#fbbf24", "#a3e635", "#f472b6", "#2dd4bf"];

export const GHOST_COLOR = "#b8bcc4";
export const UNTYPED_COLOR = "#8b8f98";

export function normalizeColor(value: string | null, index: number): string {
  if (!value) return FALLBACK[index % FALLBACK.length];
  const v = value.trim().toLowerCase();
  if (NAMED[v]) return NAMED[v];
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(v)) return v;
  return FALLBACK[index % FALLBACK.length];
}

export function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Edge kinds: Tolaria's defaults get fixed styling; any other wikilink-valued key is a custom relationship.
export interface EdgeStyle { color: string; width: number; directed: boolean; label: string }
export const EDGE_STYLES: Record<string, EdgeStyle> = {
  belongs_to: { color: "#f59e0b", width: 1.6, directed: true, label: "belongs to" },
  has: { color: "#f59e0b", width: 1.2, directed: true, label: "has" },
  related_to: { color: "#64748b", width: 1.0, directed: false, label: "related to" },
  surface_for: { color: "#a78bfa", width: 1.2, directed: true, label: "surface for" },
  body: { color: "#475569", width: 0.5, directed: false, label: "body link" },
};
export const CUSTOM_EDGE_STYLE: EdgeStyle = { color: "#22d3ee", width: 1.1, directed: true, label: "custom" };
export function edgeStyle(kind: string): EdgeStyle {
  return EDGE_STYLES[kind] ?? { ...CUSTOM_EDGE_STYLE, label: kind.replace(/_/g, " ") };
}
