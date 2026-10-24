// Which link the map draws when an agent session reads one note after another. Run with: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { followRead, resetTrails, TRAIL_WINDOW_MS } from "../src/graph/trails.ts";

// A Project P with notes a, b and c; a and b also link to each other; x is unrelated.
const links = new Set(["a-P", "b-P", "c-P", "a-b"]);
const linked = (u: string, v: string) => links.has(`${u}-${v}`) || links.has(`${v}-${u}`);

test("fan out from the Project, not a zigzag", () => {
  resetTrails();
  assert.equal(followRead("s", "P", 0, linked), null, "first read: no trail");
  assert.equal(followRead("s", "a", 1, linked), "P");
  assert.equal(followRead("s", "c", 2, linked), "P", "c is not linked to a: back to the Project");
  assert.equal(followRead("s", "b", 3, linked), "a", "the most recent linked note wins");
  assert.equal(followRead("s", "x", 4, linked), null, "an unlinked read (a search hit) draws nothing");
});

test("sessions are kept apart, and old reads expire", () => {
  resetTrails();
  followRead("one", "P", 0, linked);
  assert.equal(followRead("two", "a", 1, linked), null, "another session did not read P");
  assert.equal(followRead("one", "a", TRAIL_WINDOW_MS + 1, linked), null, "P was read too long ago");
});
