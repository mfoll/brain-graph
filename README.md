# Brain Graph

Interactive graph view of a Markdown Second Brain vault (Tolaria-style: frontmatter `type`, wikilink relationships), rendered in WebGL with nodes coloured by note Type.

Tolaria has no graph view and no plugin system (maintainer answer in refactoringhq/tolaria#587), so this is a standalone companion that reads the vault folder directly.

## What it shows

- One node per Markdown note. Colour comes from the vault's own `Type` notes (`_color` / `color`), so the legend matches Tolaria's sidebar. Size grows with the number of links.
- One edge per relationship. Every frontmatter key whose value contains wikilinks is a relationship (the Tolaria rule): `belongs_to`, `has`, `related_to`, `surface_for` and custom keys such as `source_note` or `wraps`. Body wikilinks are a separate, thinner `body` kind, hidden by default.
- Hover: tooltip with type, status, link counts and the note's first paragraph; neighbours stay lit, the rest fades.
- Click: detail panel with summary, outgoing and incoming relationships grouped by kind, frontmatter, **Open in Tolaria** (`tolaria://<vault-slug>/<path>.md`) and copy-wikilink.
- Sidebar: toggle types and relationship kinds (Alt-click isolates one), hide archived notes, hide orphans, and a focus-depth slider that keeps only the selected note's neighbourhood.
- Search box with Enter to jump; ForceAtlas2 layout runs in a web worker and settles after a few seconds (pause/run button).
- Live reload: the dev server watches the vault and re-parses on change.

## Run

```bash
pnpm install
VAULT=~/Second-Brain VAULT_LABEL="Second Brain" pnpm dev
```

Then open <http://localhost:5178>. `VAULT` defaults to `~/Second-Brain`. Set `VAULT_SLUG` if the Tolaria deep-link slug differs from the slugified label.

Other commands:

```bash
pnpm typecheck
pnpm graph:dump ~/Second-Brain -- --summary   # parser statistics and unresolved links
```

## How it works

- `server/vault.ts` walks the vault (skipping dot-folders), parses frontmatter with `yaml`, extracts the H1, first paragraph, Type metadata and all wikilinks, and resolves link targets (root stems, folder-path stems, `|alias` and `#anchor` forms).
- `server/vite-plugin-vault.ts` serves the graph at `/api/graph` and pushes change events over Server-Sent Events at `/api/events`, using `chokidar`.
- `src/` is React 19 + TypeScript on Vite 8. Rendering uses Sigma.js 4 with Graphology: the declarative styles API maps attributes to colour/size, and node/edge *state* (`isHidden`, `isHighlighted`, custom `isSelected`) drives filtering and hover emphasis without mutating the graph.

## Status

Prototype (October 2026). Known gaps: positions are recomputed on every load; no multi-vault mode; the Tolaria deep-link slug is inferred, not read from Tolaria's registry.
