// Proof of concept: follow a JSON Lines file of Endpoint Security events and report reads and writes of
// notes in the registered vaults. The file is written by a command the user runs as admin, for example
//   sudo eslogger open close create rename | grep --line-buffered -F '/vault/path/' > ~/.config/brain-graph/activity.jsonl
// eslogger and estrace share this format; Apple documents it as unstable, so every field is read defensively.
import { promises as fs, unwatchFile, watchFile } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";

export interface Activity {
  vault: string;
  /** Vault-relative note path without .md, as used for node ids. */
  id: string;
  kind: "read" | "write";
  /** Executable name of the process that touched the note, and the app responsible for it. */
  process: string;
  app: string;
  time: number;
}

/** Tools that open files to search or index them, not to read them. */
const SCANNERS = new Set(["rg", "grep", "egrep", "fgrep", "ag", "ack", "find", "fd", "git", "mdworker", "mdworker_shared", "mds", "mds_stores", "fseventsd", "backupd", "bird", "fileproviderd", "revisiond"]);
/** A process opening more distinct notes than this within the window is scanning, and is ignored for a while. */
const BURST_NOTES = 15;
const WINDOW_MS = 1500;
const QUIET_MS = 10_000;

type Json = Record<string, unknown>;
const get = (o: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Json)[k] : undefined), o);
const str = (v: unknown) => (typeof v === "string" ? v : null);

/** The path an event is about, and whether it is a read or a write; null for events that do not concern a note. */
function classify(e: Json): { file: string; kind: Activity["kind"] } | null {
  const ev = get(e, "event");
  const destination = (d: unknown) => str(get(d, "existing_file", "path")) ?? (str(get(d, "new_path", "dir", "path")) && str(get(d, "new_path", "filename")) ? path.join(str(get(d, "new_path", "dir", "path"))!, str(get(d, "new_path", "filename"))!) : null);
  if (get(ev, "open")) {
    const flags = Number(get(ev, "open", "fflag") ?? 0);
    if (flags & 0x2) return null; // opened for writing: the write is reported when the file is closed
    const file = str(get(ev, "open", "file", "path"));
    return file ? { file, kind: "read" } : null;
  }
  if (get(ev, "close")) {
    const file = str(get(ev, "close", "target", "path"));
    return file && get(ev, "close", "modified") === true ? { file, kind: "write" } : null;
  }
  if (get(ev, "create")) {
    const file = destination(get(ev, "create", "destination"));
    return file ? { file, kind: "write" } : null;
  }
  if (get(ev, "rename")) {
    const file = destination(get(ev, "rename", "destination"));
    return file ? { file, kind: "write" } : null;
  }
  return null;
}

const commandOf = new Map<number, Promise<string>>();
const command = (pid: number) => {
  let c = commandOf.get(pid);
  if (!c) {
    c = new Promise((resolve) => execFile("ps", ["-o", "command=", "-p", String(pid)], (_err, out) => resolve(String(out ?? "").trim())));
    commandOf.set(pid, c);
  }
  return c;
};
/** "Claude", "Codex", "Terminal"… from the responsible process's executable path. */
const appName = (cmd: string) => cmd.match(/([^/]+)\.app\//)?.[1] ?? path.basename(cmd.split(" ")[0] ?? "") ?? "";

export function followActivity(file: string, vaults: () => Promise<{ slug: string; path: string }[]>, emit: (a: Activity) => void): () => void {
  let offset = -1; // -1 until the first stat: history written before the server started is skipped
  let partial = "";
  let reading = false;
  const queues = new Map<number, { items: Activity[]; timer: NodeJS.Timeout }>();
  const quietUntil = new Map<number, number>();

  const flush = (pid: number) => {
    const q = queues.get(pid);
    queues.delete(pid);
    if (!q) return;
    const notes = new Set(q.items.map((a) => `${a.vault}/${a.id}`));
    if (notes.size > BURST_NOTES) {
      quietUntil.set(pid, Date.now() + QUIET_MS);
      return;
    }
    const seen = new Set<string>();
    for (const a of q.items) {
      const key = `${a.vault}/${a.id}/${a.kind}`;
      if (!seen.has(key)) emit(a);
      seen.add(key);
    }
  };

  const handle = async (line: string) => {
    let e: Json;
    try {
      e = JSON.parse(line) as Json;
    } catch {
      return;
    }
    const hit = classify(e);
    if (!hit || !hit.file.endsWith(".md")) return;
    const pid = Number(get(e, "process", "audit_token", "pid") ?? 0);
    const exe = str(get(e, "process", "executable", "path")) ?? "";
    if (pid === process.pid || SCANNERS.has(path.basename(exe))) return;
    if ((quietUntil.get(pid) ?? 0) > Date.now()) {
      quietUntil.set(pid, Date.now() + QUIET_MS);
      return;
    }
    const vault = (await vaults()).find((v) => hit.file.startsWith(v.path + path.sep));
    if (!vault) return;
    const rel = path.relative(vault.path, hit.file);
    if (rel.split(path.sep).some((s) => s.startsWith("."))) return;
    if ((await command(pid)).includes("brain-graph")) return; // another Brain Graph server reading the vault
    const rpid = Number(get(e, "process", "responsible_audit_token", "pid") ?? pid);
    const a: Activity = { vault: vault.slug, id: rel.replace(/\.md$/, "").split(path.sep).join("/"), kind: hit.kind, process: path.basename(exe), app: appName(await command(rpid)), time: Date.now() };
    const q = queues.get(pid);
    if (q) q.items.push(a);
    else queues.set(pid, { items: [a], timer: setTimeout(() => flush(pid), WINDOW_MS) });
  };

  const read = async (size: number) => {
    if (reading) return;
    reading = true;
    try {
      if (offset < 0 || size < offset) offset = offset < 0 ? size : 0; // first look, or the file was recreated
      if (size <= offset) return;
      const fh = await fs.open(file, "r");
      try {
        const buf = Buffer.alloc(size - offset);
        await fh.read(buf, 0, buf.length, offset);
        offset = size;
        const lines = (partial + buf.toString("utf8")).split("\n");
        partial = lines.pop() ?? "";
        for (const l of lines) if (l.trim()) await handle(l);
      } finally {
        await fh.close();
      }
    } catch {
      /* the file may not exist yet */
    } finally {
      reading = false;
    }
  };

  void fs.stat(file).then((s) => read(s.size), () => (offset = 0));
  watchFile(file, { interval: 200 }, (cur) => void read(cur.size));
  return () => {
    unwatchFile(file);
    for (const q of queues.values()) clearTimeout(q.timer);
  };
}
