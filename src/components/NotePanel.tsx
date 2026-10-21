import { useState } from "react";
import type { NoteNode, VaultGraph } from "../types";
import { NoteReader } from "./NoteReader";
import type { BrainGraph } from "../graph/build";
import { edgeStyle } from "../graph/colors";
import { homeChain, type HomeIndex } from "../graph/home";

interface Props {
  data: VaultGraph;
  graph: BrainGraph;
  node: NoteNode;
  typeColors: Map<string, string>;
  homeIndex: HomeIndex;
  onSelect: (id: string) => void;
  onClose: () => void;
}

export function deepLink(data: VaultGraph, id: string): string {
  return `tolaria://${data.vault.slug}/${id.split("/").map(encodeURIComponent).join("/")}.md`;
}

export function NotePanel({ data, graph, node, typeColors, homeIndex, onSelect, onClose }: Props) {
  const chain = homeChain(node, homeIndex).filter((id) => id !== node.id).reverse(); // root first
  const noteHome = homeIndex.homes.get(node.id);
  const [tab, setTab] = useState<"note" | "links">("note");
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
      {chain.length > 0 && (
        <div className="crumbs">
          {chain.map((id, i) => (
            <span key={id}>
              {i > 0 && <span className="muted"> › </span>}
              <button className="link" onClick={() => onSelect(id)} style={{ color: homeIndex.hubs.get(id)?.color }}>
                {homeIndex.hubs.get(id)?.title ?? id}
              </button>
            </span>
          ))}
          {noteHome && noteHome.alternatives.length > 0 && <span className="muted small"> (+{noteHome.alternatives.length} other parent)</span>}
          {noteHome?.viaHas && <span className="muted small"> (via has)</span>}
        </div>
      )}
      <div className="actions">
        <a className="button primary" href={deepLink(data, node.id)}>Open in Tolaria</a>
        <button className="button" onClick={() => navigator.clipboard?.writeText(`[[${node.folder ? node.id : node.stem}]]`)}>Copy wikilink</button>
      </div>
      <div className="panel-tabs">
        <button className={tab === "note" ? "on" : ""} onClick={() => setTab("note")}>Note</button>
        <button className={tab === "links" ? "on" : ""} onClick={() => setTab("links")}>
          Links <span className="count">{node.inDegree + node.outDegree}</span>
        </button>
      </div>
      {tab === "note" ? (
        <NoteReader data={data} id={node.id} onNavigate={onSelect} />
      ) : (
        <>
          {renderGroup("Outgoing", out)}
          {renderGroup("Incoming", inc)}
        </>
      )}
    </aside>
  );
}
