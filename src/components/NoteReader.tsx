import { useEffect, useMemo, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { VaultGraph } from "../types";

interface Props {
  data: VaultGraph;
  id: string;
  onNavigate: (id: string) => void;
  /** Read a note of another registered vault: its wikilinks are shown as text, since its notes are not on this map. */
  vault?: string;
}

interface NoteResponse {
  id: string;
  markdown: string;
  modified: string;
}

const WIKILINK = /\[\[([^\]]+?)\]\]/g;
const CALLOUT = /^> \[!(\w+)\]\s*\n> ?"?(.*?)"?\s*$/gm;

function splitFrontmatter(md: string): { yaml: string | null; body: string } {
  if (!md.startsWith("---")) return { yaml: null, body: md };
  const end = md.indexOf("\n---", 3);
  if (end === -1) return { yaml: null, body: md };
  return { yaml: md.slice(4, end).trim(), body: md.slice(end + 4).replace(/^\s*\n/, "") };
}

export function NoteReader({ data, id, onNavigate, vault: otherVault }: Props) {
  const slug = otherVault ?? data.vault.slug;
  const [note, setNote] = useState<NoteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showYaml, setShowYaml] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setNote(null);
    setError(null);
    fetch(`/api/note?vault=${encodeURIComponent(slug)}&id=${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? (r.json() as Promise<NoteResponse>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((n) => !cancelled && setNote(n))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [id, slug]);

  // Resolve wikilinks the same way the parser does: exact id, else unique stem.
  const resolve = useMemo(() => {
    const ids = new Set(data.nodes.map((n) => n.id));
    const byStem = new Map<string, string[]>();
    for (const n of data.nodes) (byStem.get(n.stem) ?? byStem.set(n.stem, []).get(n.stem)!).push(n.id);
    return (raw: string): string | null => {
      let t = raw.split("|")[0].split("#")[0].trim();
      if (t.endsWith(".md")) t = t.slice(0, -3);
      if (ids.has(t)) return t;
      const c = byStem.get(t.split("/").pop() ?? t);
      return c && c.length === 1 ? c[0] : null;
    };
  }, [data]);

  const html = useMemo(() => {
    if (!note) return "";
    const { body } = splitFrontmatter(note.markdown);
    const withCallouts = body.replace(CALLOUT, (_m, type: string, text: string) => `<div class="callout callout-${type.toLowerCase()}"><span class="callout-type">${type}</span>${text}</div>\n`);
    const withLinks = withCallouts.replace(WIKILINK, (_m, inner: string) => {
      const [target, alias] = inner.split("|");
      const label = (alias ?? target.split("#")[0].split("/").pop() ?? target).trim();
      const resolved = otherVault ? null : resolve(inner);
      return resolved ? `<a href="#note:${encodeURIComponent(resolved)}" class="wikilink" data-note="${resolved}">${label}</a>` : `<span class="wikilink${otherVault ? "" : " missing"}">${label}</span>`;
    });
    const rendered = marked.parse(withLinks, { async: false, gfm: true }) as string;
    const vault = encodeURIComponent(slug);
    const rebased = rendered.replace(/src="(?!https?:|data:|\/)([^"]+)"/g, (_m, src: string) => `src="/vault-file/${src.split("/").map(encodeURIComponent).join("/")}?vault=${vault}"`);
    return DOMPurify.sanitize(rebased, { ADD_ATTR: ["data-note", "target"] });
  }, [note, resolve, slug, otherVault]);

  const yaml = note ? splitFrontmatter(note.markdown).yaml : null;

  if (error) return <div className="muted small">Could not load note: {error}</div>;
  if (!note) return <div className="muted small">Loading…</div>;
  return (
    <div className="reader">
      {yaml && (
        <details className="yaml" open={showYaml} onToggle={(e) => setShowYaml((e.target as HTMLDetailsElement).open)}>
          <summary>Frontmatter</summary>
          <pre>{yaml}</pre>
        </details>
      )}
      <article
        className="markdown"
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={(e) => {
          const a = (e.target as HTMLElement).closest("a");
          if (!a) return;
          const target = a.getAttribute("data-note");
          if (target) {
            e.preventDefault();
            onNavigate(target);
          } else if (a.getAttribute("href")?.startsWith("http")) {
            a.setAttribute("target", "_blank");
            a.setAttribute("rel", "noopener");
          }
        }}
      />
      <div className="muted small">Modified {new Date(note.modified).toLocaleString()}</div>
    </div>
  );
}
