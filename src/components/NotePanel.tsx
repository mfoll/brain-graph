import type { NoteNode, VaultGraph } from "../types";
import type { BrainGraph } from "../graph/build";
import { edgeStyle } from "../graph/colors";

interface Props {
  data: VaultGraph;
  graph: BrainGraph;
  node: NoteNode;
  typeColors: Map<string, string>;
  onSelect: (id: string) => void;
  onClose: () => void;
}

export function deepLink(data: VaultGraph, id: string): string {
  return `tolaria://${data.vault.slug}/${id.split("/").map(encodeURIComponent).join("/")}.md`;
}

export function NotePanel({ data, graph, node, typeColors, onSelect, onClose }: Props) {
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const out = new Map<string, string[]>();
  const inc = new Map<string, string[]>();
  graph.forEachOutEdge(node.id, (_e, a, _s, t) => (out.get(a.kind) ?? out.set(a.kind, []).get(a.kind)!).push(t));
  graph.forEachInEdge(node.id, (_e, a, s) => (inc.get(a.kind) ?? inc.set(a.kind, []).get(a.kind)!).push(s));
  const typeName = node.type ?? "(untyped)";

  const renderGroup = (title: string, groups: Map<string, string[]>) =>
    groups.size > 0 && (
      <div className="rel-block">
        <h3>{title}</h3>
        {[...groups.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .map(([kind, ids]) => (
            <div key={kind} className="rel-group">
              <div className="rel-kind">
                <span className="edge-swatch" style={{ background: edgeStyle(kind).color }} /> {kind} <span className="count">{ids.length}</span>
              </div>
              <ul>
                {ids
                  .map((id) => byId.get(id))
                  .filter((n): n is NoteNode => !!n)
                  .sort((a, b) => a.title.localeCompare(b.title))
                  .slice(0, 40)
                  .map((n) => (
                    <li key={n.id}>
                      <button className="link note-link" onClick={() => onSelect(n.id)}>
                        <span className="dot" style={{ background: typeColors.get(n.type ?? "(untyped)") }} />
                        {n.title}
                      </button>
                    </li>
                  ))}
                {ids.length > 40 && <li className="muted small">… {ids.length - 40} more</li>}
              </ul>
            </div>
          ))}
      </div>
    );

  return (
    <aside className="note-panel">
      <button className="close" onClick={onClose} aria-label="Close">×</button>
      <div className="type-chip" style={{ background: typeColors.get(typeName) }}>{typeName}</div>
      <h2>{node.title}</h2>
      <div className="meta">
        {node.status && <span className="pill">{node.status}</span>}
        {node.archived && <span className="pill warn">archived</span>}
        <span className="muted">{node.inDegree} in · {node.outDegree} out</span>
      </div>
      <code className="path">{node.id}.md</code>
      {node.summary && <p className="summary">{node.summary}</p>}
      <div className="actions">
        <a className="button primary" href={deepLink(data, node.id)}>Open in Tolaria</a>
        <button className="button" onClick={() => navigator.clipboard?.writeText(`[[${node.folder ? node.id : node.stem}]]`)}>Copy wikilink</button>
      </div>
      {renderGroup("Outgoing", out)}
      {renderGroup("Incoming", inc)}
      {Object.keys(node.properties).length > 0 && (
        <details>
          <summary>Frontmatter</summary>
          <pre>{JSON.stringify(node.properties, null, 2)}</pre>
        </details>
      )}
    </aside>
  );
}
