import { useState } from "react";
import type { VaultRegistry } from "../useVault";

interface Props {
  registry: VaultRegistry;
  current: string | null;
  onSelect: (slug: string) => void;
  onAdd: (path: string, label?: string) => Promise<void>;
  onRemove: (path: string) => Promise<void>;
  onUseTolaria: (on: boolean) => Promise<void>;
  onClose: () => void;
}

const SOURCE_LABEL = { manual: "added here", tolaria: "from Tolaria", env: "from VAULT" } as const;

export function VaultManager({ registry, current, onSelect, onAdd, onRemove, onUseTolaria, onClose }: Props) {
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!path.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onAdd(path.trim(), label.trim() || undefined);
      setPath("");
      setLabel("");
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Vaults">
        <header>
          <h2>Vaults</h2>
          <button className="navbtn close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <p className="muted small">
          A vault is any folder of Markdown notes with frontmatter. Each one gets its own graph, saved layout and settings. The list is kept in <code>{registry.configPath}</code>.
        </p>
        <ul className="vault-list">
          {registry.vaults.map((v) => (
            <li key={v.slug} className={v.slug === current ? "current" : ""}>
              <button className="tree-label" onClick={() => onSelect(v.slug)} title={v.path}>
                <span className="name">
                  <strong>{v.label}</strong>
                  <span className="muted small"> · {SOURCE_LABEL[v.source]}</span>
                  <br />
                  <span className="muted small path-inline">{v.path}</span>
                </span>
              </button>
              {v.source === "manual" && (
                <button className="iso on" onClick={() => void onRemove(v.path)} title="Remove from the list (the folder is not touched)">
                  remove
                </button>
              )}
            </li>
          ))}
          {registry.vaults.length === 0 && <li className="muted small">No vault yet. Add a folder below.</li>}
        </ul>
        <div className="add-vault">
          <input type="text" placeholder="Folder path, e.g. ~/Second-Brain" value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void add()} />
          <input type="text" placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void add()} />
          <button className="button primary" onClick={() => void add()} disabled={busy || !path.trim()}>
            Add folder
          </button>
        </div>
        {error && <div className="small error-text">{error}</div>}
        <div className="muted small">The path is read by the local server, so it is a path on this machine; <code>~</code> is your home folder. Deep links use <code>tolaria://&lt;slug&gt;/…</code> with the slug made from the label.</div>
        {registry.tolariaAvailable && (
          <label className="row" title="Tolaria keeps its own list of vaults; import it so they appear here without adding them by hand.">
            <input type="checkbox" checked={registry.useTolaria} onChange={(e) => void onUseTolaria(e.target.checked)} />
            Include the vaults registered in Tolaria
          </label>
        )}
      </div>
    </div>
  );
}
