// The static demo's "Replay agent": no agent reports to a page on GitHub Pages, so it plays a made-up
// session built from the vault's own links. Two agents work at once; each takes a few of the most
// linked Projects in turn, reads the Project and the notes most linked to it, then writes the Project
// (and now and then one of those notes). Same vault, same story: the order is seeded by the vault slug.

export interface ReplayStep {
  /** Milliseconds after the start. */
  at: number;
  id: string;
  kind: "read" | "write";
  source: "claude" | "codex";
}

interface Input {
  slug: string;
  /** Notes to build bursts around, best first (the open note first when there is one). */
  hubs: string[];
  /** The notes linked to a hub, most linked first; only notes shown on the map. */
  linked: (id: string) => string[];
}

const BURSTS_PER_AGENT = 4;
const READS_PER_BURST = 7;

function random(seed: string) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

export function replayStory({ slug, hubs, linked }: Input): ReplayStep[] {
  const rand = random(slug);
  const steps: ReplayStep[] = [];
  const agents = ["claude", "codex"] as const;
  const picked = hubs.slice(0, BURSTS_PER_AGENT * agents.length);
  agents.forEach((source, a) => {
    let t = a * 700; // the second agent starts a moment later
    picked
      .filter((_, i) => i % agents.length === a)
      .forEach((hub) => {
        const notes = linked(hub).slice(0, READS_PER_BURST + 3);
        // Mostly the most linked notes, in a slightly shuffled order, as an agent following links would.
        const reads = [hub, ...notes.sort(() => rand() - 0.5).slice(0, READS_PER_BURST - 1)];
        for (const id of reads) {
          steps.push({ at: t, id, kind: "read", source });
          t += 200 + rand() * 180;
        }
        t += 350;
        steps.push({ at: t, id: hub, kind: "write", source });
        if (reads.length > 2 && rand() < 0.5) steps.push({ at: (t += 300), id: reads[1 + Math.floor(rand() * (reads.length - 1))], kind: "write", source });
        t += 650;
      });
  });
  return steps.sort((x, y) => x.at - y.at);
}
