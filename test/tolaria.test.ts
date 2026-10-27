// Where Brain Graph looks for Tolaria's vault list on each system. Run with: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findTolariaRegistry, tolariaRegistryCandidates } from "../server/tolaria.ts";

test("candidates per system, in Tolaria's order", () => {
  assert.deepEqual(tolariaRegistryCandidates({}, "/home/ada", "linux"), [
    "/home/ada/.config/com.tolaria.app/vaults.json",
    "/home/ada/.config/com.laputa.app/vaults.json",
  ]);
  assert.equal(tolariaRegistryCandidates({ XDG_CONFIG_HOME: "/data/cfg" }, "/home/ada", "linux")[0], "/data/cfg/com.tolaria.app/vaults.json");
  assert.equal(tolariaRegistryCandidates({ XDG_CONFIG_HOME: "relative" }, "/home/ada", "linux")[0], "/home/ada/.config/com.tolaria.app/vaults.json", "a relative XDG_CONFIG_HOME is ignored, as Tolaria does");
  assert.deepEqual(tolariaRegistryCandidates({}, "/Users/ada", "darwin").filter((f) => f.includes("tolaria.app")), [
    "/Users/ada/.config/com.tolaria.app/vaults.json",
    "/Users/ada/Library/Application Support/com.tolaria.app/vaults.json",
  ]);
  assert.equal(tolariaRegistryCandidates({ APPDATA: "C:\\Users\\ada\\AppData\\Roaming" }, "C:\\Users\\ada", "win32")[0], "C:\\Users\\ada\\AppData\\Roaming\\com.tolaria.app\\vaults.json");
});

test("the most recently written list wins", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "bg-tolaria-"));
  const candidates = tolariaRegistryCandidates({}, home, "darwin");
  assert.equal(await findTolariaRegistry(candidates), null, "no Tolaria");
  const [xdg, , platform] = candidates;
  for (const f of [xdg, platform]) {
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, "{}");
  }
  await utimes(xdg, new Date(2026, 9, 23, 14, 36), new Date(2026, 9, 23, 14, 36));
  await utimes(platform, new Date(2026, 9, 23, 18, 50), new Date(2026, 9, 23, 18, 50));
  assert.equal(await findTolariaRegistry(candidates), platform, "the older XDG copy loses");
  await utimes(xdg, new Date(2026, 9, 24), new Date(2026, 9, 24));
  assert.equal(await findTolariaRegistry(candidates), xdg);
});
