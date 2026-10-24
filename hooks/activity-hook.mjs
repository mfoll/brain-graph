#!/usr/bin/env node
// Brain Graph activity hook for Claude Code and Codex (PostToolUse). Reads the hook payload on stdin,
// works out which Markdown files the tool read or wrote, and reports them to the local Brain Graph
// server so the map can pulse those notes. It never affects the agent: it prints nothing, always exits
// 0, and gives up after half a second when Brain Graph is not running.
//
//   node activity-hook.mjs <source> [server-url]      source: claude | codex
// Installed by `brain-graph install-hooks`, which copies it to ~/.config/brain-graph/.
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Programs that open files to search or list them, not to read them: their file arguments are not reads. */
const SCANNERS = new Set(["rg", "grep", "egrep", "fgrep", "ag", "ack", "find", "fd", "git", "ls", "tree", "wc", "stat", "du", "file"]);
const SHELLS = new Set(["bash", "sh", "zsh"]);
const MD = /[~\w.@+\-/]*\.md\b/g;

/** Split a shell command into simple commands, and each into words (quotes kept as part of the text). */
function segments(command) {
  return command
    .split(/\|\||&&|[;|&\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
const words = (seg) => seg.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
const unquote = (w) => w.replace(/^['"]|['"]$/g, "");
const expand = (f) => f.replace(/^~(?=\/|$)/, os.homedir());

function fromShell(command, out, cwd, depth = 0) {
  // bash -lc "…" (Codex wraps commands this way): unpack the script whole, before splitting it, so a cd
  // inside it applies to the commands that follow.
  const wrapped = command.match(/^\s*(?:\S*\/)?(?:bash|sh|zsh)\s+-\w*c\s+([\s\S]+)$/);
  if (wrapped && depth < 2) return fromShell(unquote(wrapped[1].trim()), out, cwd, depth + 1);
  for (const seg of segments(command)) {
    const w = words(seg);
    const program = path.basename(unquote(w[0] ?? ""));
    // bash -lc "…" and similar wrappers: look inside.
    if (SHELLS.has(program) && depth < 2) {
      const i = w.findIndex((x) => /^-\w*c$/.test(x));
      if (i >= 0 && w[i + 1]) fromShell(unquote(w.slice(i + 1).join(" ")), out, cwd, depth + 1);
      continue;
    }
    if (program === "cd") {
      cwd = path.resolve(cwd, expand(unquote(w[1] ?? "~")));
      continue;
    }
    if (SCANNERS.has(program)) continue;
    const inPlace = /\s-i\b/.test(seg) && (program === "sed" || program === "perl");
    const targets = new Set();
    seg.replace(/>>?\s*(['"]?)([^\s'"]+\.md)\1/g, (_m, _q, f) => (targets.add(f), ""));
    if (program === "tee") w.slice(1).forEach((x) => unquote(x).endsWith(".md") && targets.add(unquote(x)));
    if (program === "mv" || program === "cp") {
      const last = unquote(w[w.length - 1] ?? "");
      if (last.endsWith(".md")) targets.add(last);
    }
    for (const f of seg.match(MD) ?? []) out.push({ file: path.resolve(cwd, expand(f)), kind: inPlace || targets.has(f) ? "write" : "read" });
  }
}

/** The note reads and writes in one PostToolUse payload, as absolute paths. */
export function extract(p) {
  const tool = String(p.tool_name ?? "");
  const input = p.tool_input ?? {};
  const cwd = typeof p.cwd === "string" ? p.cwd : process.cwd();
  const out = [];
  if (tool === "Read") out.push({ file: input.file_path, kind: "read" });
  else if (["Edit", "Write", "MultiEdit"].includes(tool)) out.push({ file: input.file_path, kind: "write" });
  else if (tool === "NotebookEdit") out.push({ file: input.notebook_path, kind: "write" });
  else if (tool === "apply_patch") {
    const patch = Array.isArray(input.command) ? input.command.join("\n") : String(input.command ?? "");
    for (const m of patch.matchAll(/^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm)) out.push({ file: m[1].trim(), kind: "write" });
  } else if (tool === "Bash") {
    const command = Array.isArray(input.command) ? input.command.join(" ") : String(input.command ?? "");
    fromShell(command, out, cwd);
  }
  // Search tools (Grep, Glob) and everything else are not reported.
  const seen = new Set();
  return out
    .filter((x) => typeof x.file === "string" && x.file.endsWith(".md"))
    .map((x) => ({ path: path.resolve(cwd, expand(x.file)), kind: x.kind }))
    .filter((x) => !seen.has(x.path + x.kind) && seen.add(x.path + x.kind))
    .slice(0, 50);
}

/** The report sent to Brain Graph: the notes read or written, and the agent session they belong to, so the
 * map can draw the links one session follows (two sessions at once must not be mixed up). */
export function report(p, source) {
  const session = p.session_id ?? p.sessionId;
  return { source, session: typeof session === "string" ? session.slice(0, 64) : undefined, items: extract(p) };
}

async function main() {
  const [, , source = "agent", url = process.env.BRAIN_GRAPH_URL ?? "http://127.0.0.1:5178"] = process.argv;
  try {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    const body = report(JSON.parse(raw), source);
    if (body.items.length)
      await fetch(`${url}/api/activity`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(500) });
  } catch {
    /* Brain Graph not running, or a payload this hook does not understand: say nothing. */
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
