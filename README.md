# Brain Graph

An interactive map of a Markdown vault whose notes have a `type` and link to each other through frontmatter, as in [Tolaria](https://tolaria.md/) and the [Second Brain template](https://github.com/mfoll/second-brain-template). Each note is a node and each relationship a link. Notes are coloured and grouped by the Project, Responsibility or Topic they belong to. It runs locally, opens notes in Tolaria, and never writes to the vault.

![A 1,300-note vault: coloured group regions, hierarchy links in orange, and the Settings tab](docs/brain-graph-second-brain.webp)

## Why

[Portent](https://github.com/refactoringhq/portent), the specification Tolaria follows, gives each note a `type` and typed relationships: `belongs_to` points to a parent, `has` lists highlights, `related_to` links sideways. Tolaria shows these relationships one note at a time. It has no graph view ([refactoringhq/tolaria#587](https://github.com/refactoringhq/tolaria/issues/587)) and no plugin system yet ([#1046](https://github.com/refactoringhq/tolaria/issues/1046)).

Brain Graph shows the whole vault at once: how large each project is, where areas of work connect, and which notes have no place in the hierarchy. It reads the folder directly, so Tolaria is optional. Any folder of Markdown notes with a `type` in their frontmatter works.

## Features

- **Groups.** Every note takes the colour of the group it belongs to through its `belongs_to` links. Choose which types count as groups and how deep the colouring goes: top-level groups, their sub-groups, or each note's nearest group. Groups get a shaded region and a name.
- **Links.** Every frontmatter key holding wikilinks becomes a link kind that you can show or hide. Links written in the note text are a separate kind, hidden by default. Parent links pull harder in the layout than other links.
- **Explore.** Browse the group tree, the types and the link kinds in the sidebar. Click any of them to light its notes and fade the rest. Under a type, click a property value such as `status: Active` to light those notes.
- **Note panel.** Read the note with its callouts, tables and images, follow wikilinks across the map, list its links by kind, and see the members of a group. **why?** shows the links that place a note in its group. **Open in Tolaria** opens the note there.
- **Checks.** **Unassigned** lists notes with no group. **Outside the hierarchy** lists notes that are never placed in one, such as Guides or archived notes. Links to missing notes can be shown as grey dots.
- **Other vaults.** When a note's frontmatter holds a path to a note in another vault you have added, that note appears as a rectangle beside it. Hover it for its title, or click it to read it in the panel.
- **Filters.** Hide archived notes, orphans or weakly linked notes. Fold leaf types such as Sources into a count on their parent. Show only the neighbourhood of the selection.
- **Stable layout.** The map is saved per vault and restored on the next start. New notes are placed next to the note they are most linked to. **Update layout** tidies the current map; **Reset layout** starts again and keeps the previous map as a backup.
- **Views and sharing.** Save a combination of filters, focus and colouring as a named view. The URL holds the vault, note and focus, so another note or a report can link to a view. **Export PNG** saves the current picture.
- **Live.** The map updates when a note changes on disk.

## Install

You need [Node.js](https://nodejs.org/) 20.19 or newer.

```bash
npx github:mfoll/brain-graph ~/path/to/vault
```

The first run builds the app, which takes about a minute. Then open <http://localhost:5178>. Without a folder argument, Brain Graph lists the vaults you have opened in Tolaria plus any folder you add in the app. Options: `--port 5178`, `--no-open`.

To install it as a command:

```bash
npm install -g github:mfoll/brain-graph
brain-graph ~/path/to/vault
```

Brain Graph keeps its own files in `~/.config/brain-graph/`: the vault list and one saved layout per vault. A coding agent can install and run it from the instructions in [AGENTS.md](AGENTS.md).

## Using it

- **Switch vaults** from the menu at the top left. **Manage vaults…** adds or removes folders.
- **Search** with the box in the header. Enter opens a single match, or lights all of them.
- **Focus a group** by clicking it in Explore → Groups. Press Escape to unfocus, and again to close the panel.
- **Check the hierarchy**: focus Unassigned, open a note, and read its **why?** line. Fix its `belongs_to` in Tolaria and the map updates.
- **Adjust the picture** in Settings: Grouping decides what forms a group, Layout how tight the map is, Appearance the colours and labels, Filters what is shown.

## Vault conventions

The defaults follow Tolaria and the Second Brain template.

| Convention | Default | Change it in |
| --- | --- | --- |
| Group types | Project, Responsibility, Topic, or the most linked-to types when a vault has none of these | Settings → Grouping |
| Parent links | `belongs_to`, `parent_*` | Settings → Grouping → Link roles |
| Children links, used only when a note has no parent link | `has` | Settings → Grouping |
| Other links | `related_to`, `surface_for`, links in the text, any other key | Settings → Grouping → Link roles |
| Types never placed in a group | Recap, Guide, Operation, Type, and types flagged `hierarchy_exempt: true` | Settings → Grouping → Outside the hierarchy |
| Notes never placed in a group | archived notes, and Inbox notes (`_organized: false` or `status: Unprocessed`) | frontmatter |
| Topics that may head an area | `hierarchy_root: true` | frontmatter |
| Notes allowed two parents | `accepted_double_parent: true` | frontmatter |
| Root type | Responsibility | code only (`rootTypes`) |
| People with no parent | coloured by their first related group | code only (`lateralHomeTypes`) |
| Archived notes | `_archived: true` or `archived: true` | Settings → Filters |
| Colours when a vault has no groups | `_color` on `type: Type` notes | the Type notes |
| Tolaria links | `tolaria://<slug>/<path>.md`, slug from the vault name | `VAULT_SLUG` |

`has` comes second because vaults often use it to list highlights rather than members. These rules match the template's hierarchy audit, so `pnpm graph:homes` and the template's lint report the same warnings.

## Development

```bash
git clone https://github.com/mfoll/brain-graph && cd brain-graph
pnpm install
VAULT=~/path/to/vault VAULT_LABEL="Name" pnpm dev   # dev server with hot reload on port 5178
```

```bash
pnpm typecheck
pnpm build                                # app and server into dist/, served by bin/brain-graph.mjs
pnpm start -- ~/path/to/vault             # run the built CLI from the checkout
pnpm graph:dump ~/my-vault -- --summary   # parser statistics and unresolved links
pnpm graph:homes ~/my-vault               # the group hierarchy and its problems
```

`graph:homes` prints the group tree and lists Projects without a proper parent, notes with two parents, notes reached only through `has`, and notes with no group, followed by a summary line. Add `--json` for machine-readable output.

Issues and pull requests are welcome. Keep vault conventions configurable, and run `pnpm typecheck` first.

### Code layout

- `server/vault.ts` reads the vault: frontmatter, titles, first paragraphs and wikilinks.
- `server/api.ts` serves the graph, note text, saved layouts and change events. The Vite plugin uses it in development and `bin/brain-graph.mjs` in the CLI.
- `src/graph/home.ts` decides each note's group.
- `src/graph/build.ts` builds the graph and its colours; `src/graph/hulls.ts` draws regions and names.
- `src/components/` holds the React interface. Rendering uses [Sigma.js](https://www.sigmajs.org/) 4 and [Graphology](https://graphology.github.io/), with ForceAtlas2 for the layout.

## Related tools

| Tool | Notes |
| --- | --- |
| [Tolaria](https://tolaria.md/) ([source](https://github.com/refactoringhq/tolaria)) | The desktop app Brain Graph is built for. It reads the same files and opens notes from Brain Graph's links. |
| [Portent](https://github.com/refactoringhq/portent) | The open specification behind the note types and relationships. |
| [Second Brain template](https://github.com/mfoll/second-brain-template) | A vault template with agent instructions and lint checks. Brain Graph follows its hierarchy rules. |
| [Obsidian graph view](https://obsidian.md/help/plugins/graph) | Works on any Markdown folder but uses only links in the text, not frontmatter relationships. |
| [Quartz](https://quartz.jzhao.xyz/), [Foam](https://foambubble.github.io/) | Link graphs that need their own site build or editor. |

## Status

In daily use since October 2026 on a 1,300-note vault. One vault is shown at a time; notes from other vaults appear only where this vault links to them. The Tolaria slug is derived from the vault name.

## Licence

MIT, see [LICENSE](LICENSE). Brain Graph is not affiliated with Tolaria or Refactoring.
