import type { VaultGraph } from "../types";
import type { BrainGraph } from "../graph/build";
import { NoteReader } from "./NoteReader";
import { STATIC } from "../staticSite";

export interface BridgeAttrs {
  vault: string;
  vaultLabel: string;
  path: string;
  via: string;
  type: string | null;
  summary: string;
}

interface Props {
  data: VaultGraph;
  graph: BrainGraph;
  id: string;
  title: string;
  bridge: BridgeAttrs;
  onSelect: (id: string) => void;
  onClose: () => void;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
}

/** Panel for a note of another vault that this vault links to: who links to it, its text, and a link to open it there. */
export function ExternalPanel({ data, graph, id, title, bridge, onSelect, onClose, canBack, canForward, onBack, onForward }: Props) {
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const from = graph.hasNode(id) ? graph.inNeighbors(id) : [];
  const href = `tolaria://${bridge.vault}/${bridge.path.split("/").map(encodeURIComponent).join("/")}`;
  return (
    <aside className="note-panel">
      <div className="panel-nav">
        <button className="navbtn" onClick={onBack} disabled={!canBack} title="Back to the previous note" aria-label="Back">‹</button>
        <button className="navbtn" onClick={onForward} disabled={!canForward} title="Forward" aria-label="Forward">›</button>
        <button className="navbtn close" onClick={onClose} title="Close (Esc)" aria-label="Close">×</button>
      </div>
      <div className="type-tag">▬ {bridge.type ?? "note"}</div>
      <h2>{title}</h2>
      <div className="meta">
        <span className="pill">in {bridge.vaultLabel}</span>
        <span className="muted">linked from {from.length} {from.length === 1 ? "note" : "notes"} here</span>
      </div>
      <code className="path">{bridge.path}</code>
      <div className="crumbs small">
        {from.map((f, i) => (
          <span key={f}>
            {i > 0 && <span className="muted"> · </span>}
            <button className="link" onClick={() => onSelect(f)}>
              {byId.get(f)?.title ?? f}
            </button>
          </span>
        ))}
      </div>
      {!STATIC && (
        <div className="actions">
          <a className="button primary" href={href}>Open in Tolaria</a>
        </div>
      )}
      <NoteReader data={data} vault={bridge.vault} id={bridge.path.replace(/\.md$/, "")} onNavigate={onSelect} />
    </aside>
  );
}
