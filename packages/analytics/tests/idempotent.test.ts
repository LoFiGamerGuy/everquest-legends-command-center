/**
 * Idempotency (docs/PROJECTIONS_SPEC.md §9.4): re-running `updateProjections`
 * at head is a no-op (watermark + `event_id` UNIQUE on domain rows).
 */

import { describe, expect, it } from "vitest";

import { rebuildProjections, updateProjections } from "../src/index.js";
import { groupFightScenario } from "./fixtures.js";
import { freshDb, insertEvents, snapshotJson } from "./support.js";

describe("idempotency", () => {
  it("a second update at head changes nothing", () => {
    const { db } = freshDb();
    insertEvents(db, groupFightScenario().events);
    updateProjections(db);
    const atHead = snapshotJson(db);

    const r1 = updateProjections(db);
    expect(r1.processed).toBe(0);
    expect(snapshotJson(db)).toBe(atHead);

    const r2 = updateProjections(db);
    expect(r2.processed).toBe(0);
    expect(snapshotJson(db)).toBe(atHead);
  });

  it("update after a rebuild is a no-op", () => {
    const { db } = freshDb();
    insertEvents(db, groupFightScenario().events);
    rebuildProjections(db);
    const afterRebuild = snapshotJson(db);
    const r = updateProjections(db);
    expect(r.processed).toBe(0);
    expect(snapshotJson(db)).toBe(afterRebuild);
  });
});
