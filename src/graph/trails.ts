// Which link an agent probably followed. Agents report only "read note A, then note B", never the link,
// so the map infers it: when a session reads a note, the most recent note the same session read in the
// last two minutes that links to it (either way) is where it came from. Taking the most recent linked
// note, not just the previous read, gives the shape of the exploration: a Project read before five of its
// notes sends five trails out of the Project rather than a zigzag between them.

export const TRAIL_WINDOW_MS = 120_000;
const RECENT_PER_SESSION = 12;

interface Read {
  id: string;
  t: number;
}

// Kept outside any one map, like the pulses: a file change rebuilds the map and the trail must carry on.
const sessions = new Map<string, Read[]>();

/**
 * Record that `session` read `id` at `now`, and return the note it most likely came from, or null.
 * `linked` says whether two notes are linked by any link kind, shown or hidden.
 */
export function followRead(session: string, id: string, now: number, linked: (a: string, b: string) => boolean): string | null {
  const recent = (sessions.get(session) ?? []).filter((r) => now - r.t <= TRAIL_WINDOW_MS && r.id !== id);
  let from: string | null = null;
  for (let i = recent.length - 1; i >= 0 && !from; i--) if (linked(recent[i].id, id)) from = recent[i].id;
  recent.push({ id, t: now });
  sessions.set(session, recent.slice(-RECENT_PER_SESSION));
  return from;
}

/** Forget every session (tests). */
export function resetTrails(): void {
  sessions.clear();
}
