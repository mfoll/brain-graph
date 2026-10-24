import { useState } from "react";
import type { VaultRegistry } from "../useVault";
import { STATIC } from "../staticSite";

interface Props {
  registry: VaultRegistry;
  current: string | null;
  onSelect: (slug: string) => void;
  onAdd: (path: string, label?: string) => Promise<void>;
  onRemove: (path: string) => Promise<void>;
  onUseTolaria: (on: boolean) => Promise<void>;
  onClose: () => void;
}

const SOURCE_LABEL = { manual: "added here", tolaria: "from Tolaria", env: "from the VAULT variable the server was started with" } as const;

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
        {!STATIC && (
          <p className="muted small">
            Any folder of Markdown notes can be a vault. The list is saved in <code>{registry.configPath}</code>.
          </p>
        )}
        <ul className="vault-list">
          {registry.vaults.map((v) => (
            <li key={v.slug} className={v.slug === current ? "current" : ""}>
              <button className="tree-label" onClick={() => onSelect(v.slug)} title={v.path}>
                <span className="name">
                  <strong>{v.label}</strong>
                  {!STATIC && (
                    <>
                      <span className="muted small"> · {SOURCE_LABEL[v.source]}</span>
                      <br />
                      <span className="muted small path-inline">{v.path}</span>
                    </>
                  )}
                </span>
              </button>
              {v.source === "manual" && !STATIC && (
                <button className="iso on" onClick={() => void onRemove(v.path)} title="Remove from the list. The folder is not changed.">
                  remove
                </button>
              )}
            </li>
          ))}
          {registry.vaults.length === 0 && <li className="muted small">No vault yet. Add a folder below.</li>}
        </ul>
        {/* The static demo serves a fixed set of vaults: no folders to add. */}
        {!STATIC && (
          <>
            <div className="add-vault">
              <input type="text" placeholder="Folder path, e.g. ~/my-vault" value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void add()} />
              <input type="text" placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void add()} />
              <button className="button primary" onClick={() => void add()} disabled={busy || !path.trim()}>
                Add folder
              </button>
            </div>
            {error && <div className="small error-text">{error}</div>}
            <div className="muted small">A path on this machine; <code>~</code> is your home folder.</div>
            {registry.tolariaAvailable && (
              <label className="row" title="Also list the vaults you have opened in Tolaria">
                <input type="checkbox" checked={registry.useTolaria} onChange={(e) => void onUseTolaria(e.target.checked)} />
                Include the vaults registered in Tolaria
              </label>
            )}
          </>
        )}
      </div>
    </div>
  );
}
