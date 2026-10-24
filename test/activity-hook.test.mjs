// What the agent hook reports for typical Claude Code and Codex tool calls. Run with: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { extract, report } from "../hooks/activity-hook.mjs";

const V = "/vault";
const run = (tool_name, tool_input) => extract({ tool_name, tool_input, cwd: V }).map((x) => `${x.kind} ${x.path}`);

test("Claude Code tools", () => {
  assert.deepEqual(run("Read", { file_path: "/vault/a.md" }), ["read /vault/a.md"]);
  assert.deepEqual(run("Edit", { file_path: "notes/b.md" }), ["write /vault/notes/b.md"]);
  assert.deepEqual(run("Grep", { pattern: "x", path: V }), [], "searches are not reads");
  assert.deepEqual(run("Read", { file_path: "/vault/data.json" }), [], "only Markdown");
});

test("shell commands", () => {
  assert.deepEqual(run("Bash", { command: "cat a.md b.md | head -20" }), ["read /vault/a.md", "read /vault/b.md"]);
  assert.deepEqual(run("Bash", { command: 'bash -lc "cd procedures && sed -n 1,80p lint.md"' }), ["read /vault/procedures/lint.md"], "cd inside a wrapped script");
  assert.deepEqual(run("Bash", { command: ["zsh", "-lc", "cat ~/x.md"] }).length, 1, "array form");
  assert.deepEqual(run("Bash", { command: "rg -l belongs_to . && git log a.md" }), [], "scanners are ignored");
  assert.deepEqual(run("Bash", { command: "sed -i '' s/a/b/ c.md" }), ["write /vault/c.md"]);
  assert.deepEqual(run("Bash", { command: "echo hi > d.md" }), ["write /vault/d.md"]);
});

test("Codex patches", () => {
  const patch = "*** Begin Patch\n*** Update File: e.md\n@@\n-a\n+b\n*** Add File: notes/f.md\n+x\n*** Delete File: g.md\n*** End Patch";
  assert.deepEqual(run("apply_patch", { command: patch }), ["write /vault/e.md", "write /vault/notes/f.md"], "deleted notes are not pulsed");
});

test("session", () => {
  const p = { tool_name: "Read", tool_input: { file_path: "/vault/a.md" }, cwd: V };
  assert.equal(report({ ...p, session_id: "abc" }, "claude").session, "abc", "passed on, so trails follow one session");
  assert.equal(report(p, "codex").session, undefined, "absent when the agent does not say");
});
