/**
 * Rebuild semantics: `rebuildProjections` is ALWAYS a full wipe + replay from
 * event 1 (there is no `from` option that could silently drop events ≤ from).
 * A rebuild run after a partial incremental update must reprocess everything and
 * land on the same full state as a from-scratch rebuild.
 */

import { describe, expect, it } from "vitest";

import { rebuildProjections, updateProjections } from "../src/index.js";
import { groupFightScenario } from "./fixtures.js";
import { freshDb, insertEvents, snapshotJson } from "./support.js";

describe("rebuild always reprocesses from the start", () => {
  it("rebuild after a partial update equals a from-scratch rebuild", () => {
    const events = groupFightScenario().events;
    const mid = Math.floor(events.length / 2);

    // db1: catch up partway, then a couple more, then a full rebuild on top.
    const db1 = freshDb().db;
    insertEvents(db1, events.slice(0, mid));
    updateProjections(db1);
    insertEvents(db1, events.slice(mid));
    updateProjections(db1);
    rebuildProjections(db1);

    // db2: everything in one from-scratch rebuild.
    const db2 = freshDb().db;
    insertEvents(db2, events);
    rebuildProjections(db2);

    expect(snapshotJson(db1)).toBe(snapshotJson(db2));
  });

  it("rebuild reprocesses every event (watermark returns to head, not a partial point)", () => {
    const events = groupFightScenario().events;
    const { db } = freshDb();
    insertEvents(db, events);
    updateProjections(db);
    const r = rebuildProjections(db);
    // A full wipe + replay processes all events (id 1..N), not just id > some `from`.
    expect(r.processed).toBe(events.length);
  });
});
