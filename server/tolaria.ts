// Where Tolaria keeps its list of vaults. Tolaria (its ADR 0145) writes app config under the XDG
// config home on Linux and macOS (`$XDG_CONFIG_HOME` or `~/.config`), falls back to the system's own
// config folder (macOS Application Support, Windows %APPDATA%) when that is not writable, and still
// reads the folder of its former name, com.laputa.app. Which one is current depends on the Tolaria
// version and the machine, so every candidate is checked and the most recently written one wins.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const NAMESPACES = ["com.tolaria.app", "com.laputa.app"];

/** Every place Tolaria's vaults.json can be, in Tolaria's own order of preference. */
export function tolariaRegistryCandidates(env: NodeJS.ProcessEnv = process.env, home = os.homedir(), platform: NodeJS.Platform = process.platform): string[] {
  const p = platform === "win32" ? path.win32 : path.posix;
  const dirs: string[] = [];
  if (platform !== "win32") {
    const xdg = env.XDG_CONFIG_HOME;
    dirs.push(xdg && p.isAbsolute(xdg) ? xdg : p.join(home, ".config"));
  }
  if (platform === "darwin") dirs.push(p.join(home, "Library", "Application Support"));
  else if (platform === "win32") dirs.push(env.APPDATA ?? p.join(home, "AppData", "Roaming"));
  else dirs.push(p.join(home, ".config"));
  const out: string[] = [];
  for (const dir of dirs) for (const ns of NAMESPACES) out.push(p.join(dir, ns, "vaults.json"));
  return [...new Set(out)];
}

/** The candidate that exists and was written last, or null when Tolaria has no vault list here. */
export async function findTolariaRegistry(candidates = tolariaRegistryCandidates()): Promise<string | null> {
  let best: { file: string; time: number } | null = null;
  for (const file of candidates) {
    const st = await fs.stat(file).catch(() => null);
    if (st?.isFile() && (!best || st.mtimeMs > best.time)) best = { file, time: st.mtimeMs };
  }
  return best?.file ?? null;
}
