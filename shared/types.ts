// Shared between the Vite plugin (Node) and the browser app. Keep free of Node imports.

export interface NoteNode {
  id: string; // vault-relative path without .md, e.g. "procedures/lint-vault"
  stem: string; // filename stem
  title: string;
  type: string | null;
  status: string | null;
  archived: boolean;
  organized: boolean;
  folder: string; // "" for root
  summary: string; // first body paragraph, trimmed
  properties: Record<string, unknown>; // frontmatter minus relationship keys
  outDegree: number;
  inDegree: number;
  /** Last modification time of the file (ISO). */
  modified: string;
  /** Nearest hub this note rolls up to through belongs_to / inverse has: a Project when one is
   *  reachable, otherwise a Responsibility or Topic. Null when no chain reaches a hub. */
  home: string | null;
  homeKind: "project" | "area" | null;
  /** Hops from the note to its home (1 = direct belongs_to). */
  homeDepth: number | null;
  /** Other hubs reachable at the same distance (multi-parent notes). */
  homeAlternatives: string[];
}

export interface NoteEdge {
  source: string;
  target: string;
  kind: string; // frontmatter key ("belongs_to", "related_to", ...) or "body"
}

export interface TypeInfo {
  name: string;
  color: string | null;
  icon: string | null;
  order: number | null;
  count: number;
}

export interface VaultGraph {
  vault: { label: string; path: string; slug: string };
  generatedAt: string;
  nodes: NoteNode[];
  edges: NoteEdge[];
  types: TypeInfo[];
  edgeKinds: { kind: string; count: number }[];
  unresolved: { from: string; raw: string }[];
}
