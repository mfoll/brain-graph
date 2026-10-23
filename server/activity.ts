// Notes read or written by other apps. Agent hooks (hooks/activity-hook.mjs, run by
// Claude Code and Codex after each tool call) report the files a tool read or wrote; the vault watcher
// reports every file change, whichever app made it. Both end up here as Activity events for the page.
import path from "node:path";

export interface Activity {
  vault: string;
  /** Vault-relative note path without .md, as used for node ids. */
  id: string;
  kind: "read" | "write";
  /** Who touched the note: "claude", "codex", or "file" for a change seen by the watcher. */
  source: string;
  time: number;
}

/** The vault note an absolute path names, or null for anything else (other folders, hidden folders, non-Markdown). */
export function noteFor(file: string, vaults: { slug: string; path: string }[]): { vault: string; id: string } | null {
  if (!file.endsWith(".md")) return null;
  const vault = vaults.find((v) => file.startsWith(v.path + path.sep));
  if (!vault) return null;
  const rel = path.relative(vault.path, file);
  if (rel.split(path.sep).some((s) => s.startsWith("."))) return null;
  return { vault: vault.slug, id: rel.replace(/\.md$/, "").split(path.sep).join("/") };
}
