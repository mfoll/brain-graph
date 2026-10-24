import { useEffect, useState } from "react";
import type { NoteNode, VaultGraph } from "../types";
import { NoteReader } from "./NoteReader";
import { STATIC } from "../staticSite";
import { groupColor, type BrainGraph } from "../graph/build";
import { edgeStyle } from "../graph/colors";
import { SHAPE_GLYPH, acceptsDoubleParent, homeChain, outsideReason, shapeFor, subtreeMembers, type HomeIndex, type HomeLevel } from "../graph/home";

interface Props {
  data: VaultGraph;
  graph: BrainGraph;
  node: NoteNode;
  typeColors: Map<string, string>;
  homeIndex: HomeIndex;
  /** Colour level, so breadcrumbs take the colours drawn on the map. */
  level: HomeLevel;
  onSelect: (id: string) => void;
  onClose: () => void;
  /** Active tab, owned by the app so back and forward can restore it. */
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  /** Note navigation history inside the panel. */
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
}

const typeName0 = (n: NoteNode) => n.type ?? "(untyped)";

export function deepLink(data: VaultGraph, id: string): string {
  return `tolaria://${data.vault.slug}/${id.split("/").map(encodeURIComponent).join("/")}.md`;
}

export type PanelTab = "note" | "links" | "members";

export function NotePanel({ data, graph, node, typeColors, homeIndex, level, onSelect, onClose, canBack, canForward, onBack, onForward, tab: wanted, onTab }: Props) {
  const typeColor = typeColors.get(typeName0(node));
  const chain = homeChain(node, homeIndex).filter((id) => id !== node.id).reverse(); // root first
  const noteHome = homeIndex.homes.get(node.id);
  const isHub = homeIndex.hubs.has(node.id);
  // Members exists only for a group note: a restored "members" tab on a plain note shows the text instead.
  const tab: PanelTab = wanted === "members" && !isHub ? "note" : wanted;
  const setTab = onTab;
  const [showWhy, setShowWhy] = useState(false);
  useEffect(() => setShowWhy(false), [node.id]);
  const members = isHub ? [...subtreeMembers(node.id, data, homeIndex)].filter((id) => id !== node.id) : [];
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
                        <span className="dot" style={{ background: graph.hasNode(n.id) ? (graph.getNodeAttribute(n.id, "color") as string) : undefined }} />
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

  const renderMembers = () => {
    const groups = new Map<string, NoteNode[]>();
    for (const id of members) {
      const n = byId.get(id);
      if (n) (groups.get(n.type ?? "(untyped)") ?? groups.set(n.type ?? "(untyped)", []).get(n.type ?? "(untyped)")!).push(n);
    }
    const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
    return (
      <div className="rel-block">
        <div className="muted small">{members.length} notes in this group, including sub-groups.</div>
        {ordered.map(([type, notes]) => (
          <div key={type} className="rel-group">
            <div className="rel-kind">
              <span className="glyph" style={{ color: typeColors.get(type) }}>{SHAPE_GLYPH[shapeFor(type, homeIndex.settings)]}</span> {type} <span className="count">{notes.length}</span>
            </div>
            <ul>
              {notes
                .sort((a, b) => a.title.localeCompare(b.title))
                .map((n) => (
                  <li key={n.id}>
                    <button className="link note-link" onClick={() => onSelect(n.id)}>
                      <span className="dot" style={{ background: graph.hasNode(n.id) ? (graph.getNodeAttribute(n.id, "color") as string) : undefined, opacity: homeIndex.hubs.has(n.id) ? 1 : 0.6 }} />
                      {n.title}
                    </button>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </div>
    );
  };

  return (
    <aside className="note-panel">
      <div className="panel-nav">
        <button className="navbtn" onClick={onBack} disabled={!canBack} title="Back to the previous note" aria-label="Back">‹</button>
        <button className="navbtn" onClick={onForward} disabled={!canForward} title="Forward" aria-label="Forward">›</button>
        <button className="navbtn close" onClick={onClose} title="Close (Esc)" aria-label="Close">×</button>
      </div>
      <div className="type-tag" style={typeColor ? { color: typeColor, borderColor: typeColor, background: `color-mix(in srgb, ${typeColor} 14%, transparent)` } : undefined}>
        {SHAPE_GLYPH[shapeFor(node.type, homeIndex.settings)]} {typeName}
      </div>
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
              <button className="link" onClick={() => onSelect(id)} style={{ color: groupColor(homeIndex, id, level) }}>
                {homeIndex.hubs.get(id)?.title ?? id}
              </button>
            </span>
          ))}
          {noteHome && noteHome.alternatives.length > 0 && <span className="muted small"> (+{noteHome.alternatives.length} other parent{acceptsDoubleParent(node) ? ", accepted" : ""})</span>}
          {noteHome?.viaHas && <span className="muted small"> (via has)</span>}
          {noteHome?.lateral && <span className="muted small"> (related, no parent)</span>}
          {noteHome && noteHome.path.length > 0 && (
            <button className="link small why" onClick={() => setShowWhy((v) => !v)} title="Show the links that place this note in its group">
              {showWhy ? "hide why" : "why?"}
            </button>
          )}
        </div>
      )}
      {showWhy && noteHome && (
        <div className="why-chain muted small">
          <span>this note</span>
          {noteHome.path.map((step, i) => (
            <span key={i}>
              {" "}
              <span className={`via${step.via === "has" ? " weak" : ""}`}>→ {step.via === "has" ? "has (fallback)" : step.via} →</span>{" "}
              <button className="link" onClick={() => onSelect(step.id)}>
                {byId.get(step.id)?.title ?? step.id}
              </button>
            </span>
          ))}
          {noteHome.alternatives.length > 0 && <div>Also under {noteHome.alternatives.map((id) => byId.get(id)?.title ?? id).join(", ")}{acceptsDoubleParent(node) ? " (accepted)" : ""}. The first parent sets the colour.</div>}
        </div>
      )}
      {!chain.length && !isHub && <div className="crumbs muted small">{outsideReason(node, homeIndex) ? `Not placed in a group (${outsideReason(node, homeIndex)}).` : "No group: none of its parent links leads to a group."}</div>}
      <div className="actions">
        {!STATIC && <a className="button primary" href={deepLink(data, node.id)}>Open in Tolaria</a>}
        <button className="button" onClick={() => navigator.clipboard?.writeText(`[[${node.folder ? node.id : node.stem}]]`)}>Copy wikilink</button>
      </div>
      <div className="panel-tabs">
        <button className={tab === "note" ? "on" : ""} onClick={() => setTab("note")}>Note</button>
        <button className={tab === "links" ? "on" : ""} onClick={() => setTab("links")}>
          Links <span className="count">{node.inDegree + node.outDegree}</span>
        </button>
        {isHub && (
          <button className={tab === "members" ? "on" : ""} onClick={() => setTab("members")}>
            Members <span className="count">{members.length}</span>
          </button>
        )}
      </div>
      {tab === "note" && <NoteReader data={data} id={node.id} onNavigate={onSelect} />}
      {tab === "links" && (
        <>
          {renderGroup("Outgoing", out)}
          {renderGroup("Incoming", inc)}
        </>
      )}
      {tab === "members" && isHub && renderMembers()}
    </aside>
  );
}
