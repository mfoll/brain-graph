# Brain Graph

Interactive graph view of a Markdown Second Brain vault (Tolaria-style: frontmatter `type`, wikilink relationships), rendered in WebGL with nodes coloured by note Type.

Tolaria has no graph view and no plugin system (maintainer answer in refactoringhq/tolaria#587), so this is a standalone companion that reads the vault folder directly.

## What it shows

- One node per Markdown note, sized by number of links, **coloured by its group**: every note rolls up through its `belongs_to` chain to the nearest *group* note. Which types act as groups is configurable (default Project, Responsibility, Topic; when Project is among them the first Project met wins). Inverse `has` links are used only as a fallback when `belongs_to` reaches no group, because this vault uses `has` for selective entry points. A slider chooses the roll-up level. Each group type is drawn with its own shape in the order selected (◆ ■ ▲ ▬); every other note is a circle. A vault with no group notes at all falls back to the colours of its `Type` notes.
- The sidebar shows the hub hierarchy (Topics and Responsibilities → Projects → subprojects) with note counts. Clicking a row focuses it: every note of the group (or of the type, in the Types section) stays lit and labelled, everything else fades, and for a group its note opens in the panel; clicking again unfocuses, as does clicking the graph. Each Type row expands to its notes and has a hover **hide** toggle for the rare case where a type should leave the graph entirely.
- Reading: the detail panel renders the note's Markdown (callouts, tables, images from the vault) with wikilinks that navigate the graph, next to a Links tab grouping relationships by kind.
- Group regions and names: a tinted region behind each home group at the current roll-up level (the union of a soft disc per visible member note, so it follows where notes sit) with the group's name at its median position. A name appears when at least four of the group's notes are visible; names are placed largest group first and nudged up or down to avoid each other; the focused group is always named. Regions and names fade while something is hovered or focused and follow the grouping types and roll-up level. Toggle in the Home section.
- The Home tree ends with an **Unassigned** row: notes whose chain reaches no group; focus it to see them. A selected group's panel has a **Members** tab (its notes by type), and every note's breadcrumb has a **why?** link showing the exact chain of relationships the viewer followed.
- Panel navigation: back and forward arrows replay the notes you opened; Escape unfocuses, then closes the panel. A state line under the header lists what is in effect (focus, hidden types or links, skeleton view…) with one **clear** link.
- Shareable URL: `?vault=…&note=…&focus=hub:genesis|type:Question|unassigned&level=0|2` is kept up to date, so a Tolaria note or an agent report can link straight into a view.
- A **Layout physics** section exposes node size, gravity, group pull (weight of hierarchy links), LinLog group separation and overlap prevention, remembered per vault and applied live in a 1.5-second run so the effect is visible at once. Nodes cannot be dragged: hand placement does not survive the next layout run.
- Type facets: an expanded Type row lists the values of a frontmatter key found on its notes (`status` by default; any scalar key shared by enough notes can be picked), each clickable to focus those notes, e.g. Questions with `status = Open`. Nothing is specific to one vault's vocabulary.
- Toggles: hide archived, hide orphans, hide notes with fewer than N visible links (skeleton view; group notes always stay), collapse Sources into a `+N` count on their parent, fade notes by time since last edit (7 / 30 / 90 days).
- One edge per relationship. Every frontmatter key whose value contains wikilinks is a relationship (the Tolaria rule): `belongs_to`, `has`, `related_to`, `surface_for` and custom keys such as `source_note` or `wraps`. Body wikilinks are a separate, thinner `body` kind, hidden by default.
- Hover: tooltip with type, status, link counts and the note's first paragraph; neighbours stay lit, the rest fades.
- Click: detail panel with summary, outgoing and incoming relationships grouped by kind, frontmatter, **Open in Tolaria** (`tolaria://<vault-slug>/<path>.md`) and copy-wikilink.
- Sidebar: toggle types and relationship kinds (Alt-click isolates one), hide archived notes, hide orphans, and a focus-depth slider that keeps only the selected note's neighbourhood.
- Search box with Enter to jump.
- Layout: ForceAtlas2 stepped one iteration per animation frame (about 3 ms for 1,300 notes), damped from the first frame and cooled exponentially so nodes come to rest within the run: 4 s for a first layout, 1.5 s for a nudge, a settle of new notes or a physics change. **Recompute layout** reruns it from the current positions, for example after changing which relationship kinds are shown; **Stop** keeps the positions of the moment.
- Live reload: the dev server watches the vault and re-parses on change.
- The map is normalised to a fixed extent on every layout frame, so physics changes redistribute notes without changing the picture's scale; the camera frame never refits, node sizes stay constant, and **Fit** is a smooth camera move back to the full view.
- Stable map: node positions are saved to `.tmp/layouts/<vault-slug>.json` when a layout run stops (or you pause it). The next start restores them without running the layout; only new notes get a short settling run, placed next to their linked notes while everything else stays pinned. **Reset layout** forgets the saved positions.

## Run

```bash
pnpm install
pnpm dev
```

Then open <http://localhost:5178>. Every vault registered and mounted in Tolaria (read from `~/Library/Application Support/com.tolaria.app/vaults.json`) appears in the dropdown at the top left; Tolaria's default workspace is selected first and your last choice is remembered. Each vault has its own graph, saved layout, filters and grouping default: the Second Brain ontology gets Project / Responsibility / Topic, the Scientific Production Archive gets Paper / Grant (the types most often on the receiving end of `parent_*` and `belongs_to` links). Only the selected vault is read; the others are not parsed until you switch to them.

Without Tolaria, or to add a vault that is not registered, start with `VAULT=~/path/to/vault VAULT_LABEL="Name" pnpm dev`; that vault becomes the default. Set `VAULT_SLUG` if the Tolaria deep-link slug differs from the slugified label.

Other commands:

```bash
pnpm typecheck
pnpm graph:dump ~/Second-Brain -- --summary   # parser statistics and unresolved links
pnpm graph:homes ~/Second-Brain               # the inferred group hierarchy plus audit lists
                                              # (--no-has, --hubs=Project,Topic, --json)
```

`graph:homes` prints the hierarchy the viewer infers and four audit lists: Projects whose parent is a Topic, notes with several parents at the same distance, notes homed only through a `has` link, and notes with no group at all. It is meant as input for reorganising `belongs_to` in the vault; the viewer never writes to the vault.

## How it works

- `server/vault.ts` walks the vault (skipping dot-folders), parses frontmatter with `yaml`, extracts the H1, first paragraph, Type metadata and all wikilinks, and resolves link targets (root stems, folder-path stems, `|alias` and `#anchor` forms).
- `server/vite-plugin-vault.ts` serves the graph at `/api/graph` and pushes change events over Server-Sent Events at `/api/events`, using `chokidar`.
- `src/` is React 19 + TypeScript on Vite 8. Rendering uses Sigma.js 4 with Graphology: the declarative styles API maps attributes to colour/size, and node/edge *state* (`isHidden`, `isHighlighted`, custom `isSelected`) drives filtering and hover emphasis without mutating the graph.

## Status

Prototype (October 2026). Vaults are shown one at a time; cross-vault links are not drawn (there are almost none as wikilinks; the vaults reference each other through Source pointers). Hulls are a 2D canvas layer behind the WebGL stage (the stage background is transparent and the container paints it). Known gaps: the Tolaria deep-link slug is inferred from the vault label (verified for the work vault), not read from Tolaria's registry.
