// `brain-graph install-hooks` and `uninstall-hooks`: add or remove the PostToolUse hook that lets Claude
// Code and Codex report the notes they read or write, so the map can pulse them.
// The hook script is copied to ~/.config/brain-graph/ so it does not depend on where Brain Graph is installed.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();
const TARGET = path.join(HOME, ".config", "brain-graph", "activity-hook.mjs");
const SOURCE = fileURLToPath(new URL("../hooks/activity-hook.mjs", import.meta.url));
const MARK = "activity-hook.mjs"; // how our entry is recognised in a settings file

// Desktop apps may start hooks without the login shell's PATH, so the usual Node locations are added.
const command = (agent, port) =>
  `f="$HOME/.config/brain-graph/activity-hook.mjs"; [ -f "$f" ] && PATH="$PATH:/opt/homebrew/bin:/usr/local/bin" node "$f" ${agent} http://127.0.0.1:${port}; true`;

const AGENTS = {
  claude: { name: "Claude Code", dir: path.join(HOME, ".claude"), file: path.join(HOME, ".claude", "settings.json"), matcher: "Read|Edit|Write|MultiEdit|NotebookEdit|Bash", options: { timeout: 2 } },
  codex: { name: "Codex", dir: path.join(HOME, ".codex"), file: path.join(HOME, ".codex", "hooks.json"), matcher: "^(Bash|apply_patch)$", options: { timeout: 2, async: true } },
};

async function readJson(file) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON; it was left unchanged.`);
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.copyFile(file, `${file}.bak-brain-graph`).catch(() => undefined);
  await fs.writeFile(`${file}.tmp`, JSON.stringify(data, null, 2) + "\n");
  await fs.rename(`${file}.tmp`, file);
}

/** The settings without Brain Graph's hook; empty groups and an empty hooks block are dropped. */
function withoutOurs(data) {
  const groups = (data.hooks?.PostToolUse ?? [])
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !String(h.command ?? "").includes(MARK)) }))
    .filter((g) => g.hooks.length);
  const hooks = { ...data.hooks, PostToolUse: groups };
  if (!groups.length) delete hooks.PostToolUse;
  const out = { ...data, hooks };
  if (!Object.keys(hooks).length) delete out.hooks;
  return out;
}

/** The agents to act on: those named, or every one that is installed. */
async function selected(names) {
  const wanted = names.length ? names : Object.keys(AGENTS);
  const out = [];
  for (const n of wanted) {
    const a = AGENTS[n];
    if (!a) throw new Error(`Unknown agent "${n}"; use ${Object.keys(AGENTS).join(" or ")}.`);
    const present = await fs.stat(a.dir).then(() => true, () => false);
    if (present) out.push([n, a]);
    else if (names.length) console.log(`${a.name}: ${a.dir} not found, skipped.`);
  }
  return out;
}

export async function installHooks({ port = 5178, agents = [] } = {}) {
  await fs.mkdir(path.dirname(TARGET), { recursive: true });
  await fs.copyFile(SOURCE, TARGET);
  console.log(`Hook script: ${TARGET}`);
  for (const [n, a] of await selected(agents)) {
    const data = withoutOurs(await readJson(a.file));
    data.hooks = { ...data.hooks, PostToolUse: [...(data.hooks?.PostToolUse ?? []), { matcher: a.matcher, hooks: [{ type: "command", command: command(n, port), ...a.options }] }] };
    await writeJson(a.file, data);
    console.log(`${a.name}: hook added to ${a.file} (previous version kept as ${path.basename(a.file)}.bak-brain-graph).`);
  }
  console.log(`\nNew sessions report to http://127.0.0.1:${port}. Codex runs a new hook only after you trust it: start \`codex\` and use /hooks.`);
}

export async function uninstallHooks({ agents = [] } = {}) {
  for (const [, a] of await selected(agents)) {
    const before = await readJson(a.file);
    const after = withoutOurs(before);
    if (JSON.stringify(after) === JSON.stringify(before)) {
      console.log(`${a.name}: no Brain Graph hook in ${a.file}.`);
      continue;
    }
    await writeJson(a.file, after);
    console.log(`${a.name}: hook removed from ${a.file}.`);
  }
  if (!agents.length) await fs.rm(TARGET, { force: true });
}
