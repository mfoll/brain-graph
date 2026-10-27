// The command-line server's small helpers. Run with: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("a missing browser opener prints the address instead of crashing", () => {
  const helper = fileURLToPath(new URL("../bin/open-browser.mjs", import.meta.url));
  const script = `import(${JSON.stringify(helper)}).then((m) => m.openBrowser("http://localhost:5178/", "linux"))`;
  // No xdg-open on this PATH, as on a server or in WSL. Before the fix the process died with "spawn xdg-open ENOENT".
  const out = execFileSync(process.execPath, ["-e", script], { env: { PATH: "/nonexistent" }, encoding: "utf8" });
  assert.match(out, /open http:\/\/localhost:5178\/ yourself/);
});
