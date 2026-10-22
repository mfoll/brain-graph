# AGENTS.md — Brain Graph

Instructions for a coding agent asked to install, run or use Brain Graph for a user. The [README](README.md) explains what the viewer shows; this file covers what an agent needs to operate it. Brain Graph only reads a vault; it never writes to one.

## Install and run for a user

1. Check Node.js: `node --version` must be 20.19 or newer. If it is missing or older, say so and stop; installing Node is a machine-wide change the user decides.
2. Find the vault: a Second Brain vault is a folder of Markdown notes with YAML frontmatter, usually holding an `AGENTS.md` and root `type: Type` notes. Ask if the user has not named one. Never guess a folder from a search.
3. Start the viewer without opening a browser, in the background, from a folder outside the vault:

   ```bash
   npx github:mfoll/brain-graph /path/to/vault --port 5178 --no-open
   ```

   The first run clones and builds the app (about a minute, needs GitHub access to the repository); later runs start in a second. The first folder given becomes the default vault; more folders can follow.
4. Confirm it answers before reporting: `curl -s http://localhost:5178/api/vaults` returns the vault list as JSON. If the port is taken, rerun with another `--port` and report that port.
5. Report the URL `http://localhost:5178/` and that the process runs until stopped. Do not open the browser for the user unless asked.

`npm install -g github:mfoll/brain-graph` makes a permanent `brain-graph` command. It is a machine-wide install: ask for explicit approval first, and report where it was installed.

## Boundaries

- Read-only toward the vault. Fixing what the map reveals (a wrong `belongs_to`, a missing parent) is an edit to the vault under the vault's own rules, not part of running the viewer.
- Brain Graph's state lives in `~/.config/brain-graph/`: `vaults.json` (the vault list, also edited from the app) and `layouts/<slug>.json` with a `.prev.json` backup. Mention this when uninstalling or when a user asks what it stored. Nothing else is written outside the npm cache.
- The server binds to `127.0.0.1` only. Do not expose it on another interface or behind a tunnel without the user asking.
- Vaults registered in Tolaria are served automatically when its registry exists; this is read-only and optional. Do not edit Tolaria's registry.
- `graph:homes` and `graph:dump` print the vault's structure to the terminal; that output may contain note titles and summaries. Treat it like the vault's content when deciding where it may be pasted.

## Commands useful to an agent

From a checkout (`git clone https://github.com/mfoll/brain-graph && pnpm install`):

```bash
pnpm graph:homes /path/to/vault            # inferred group hierarchy plus four audit lists
pnpm graph:homes /path/to/vault -- --json  # the same, machine-readable
pnpm graph:dump /path/to/vault -- --summary # parser statistics and unresolved links
```

`graph:homes` lists Projects whose parent is a Topic, notes with several parents at the same distance, notes homed only through a `has` link, and notes reaching no group. Use it as input for a hierarchy review; the viewer shows the same chains interactively (Explore → Groups → Unassigned, and the **why?** link on a note).

## Linking into a view

The viewer keeps its state in the URL, so a report or a vault note can point at exactly one view:

```text
http://localhost:5178/?vault=<slug>&note=<stem>              # a note, panel open
http://localhost:5178/?vault=<slug>&focus=hub:<stem>&level=0 # a group lit, coloured at the first level
http://localhost:5178/?vault=<slug>&focus=type:Question
http://localhost:5178/?vault=<slug>&focus=unassigned
```

`<slug>` is the slugified vault label (`second-brain` for "Second Brain"); `<stem>` is the note's filename without `.md`. The **Open in Tolaria** button uses `tolaria://<slug>/<path>.md`; set `VAULT_SLUG` when Tolaria's slug differs from the label.

## Working on the code

Vite 8, React 19, TypeScript, pnpm. `pnpm dev` with `VAULT=/path VAULT_LABEL="Name"` for hot reload; `pnpm typecheck` before a pull request; `pnpm build` produces `dist/` (app and compiled server) that `bin/brain-graph.mjs` serves. The README's "How it works" section maps the folders. Keep vault conventions (group types, link roles, archived flags) configurable per vault rather than hard-coded, and keep the viewer read-only.
