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
