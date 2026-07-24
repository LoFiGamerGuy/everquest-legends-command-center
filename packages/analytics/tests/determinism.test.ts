/**
 * Determinism (docs/PROJECTIONS_SPEC.md §9.1): a full rebuild over a fixture
 * event set yields byte-identical projection rows across runs.
 */

import { describe, expect, it } from "vitest";

import { rebuildProjections } from "../src/index.js";
import { groupFightScenario } from "./fixtures.js";
import { freshDb, insertEvents, snapshotJson } from "./support.js";

describe("determinism", () => {
  it("produces byte-identical rows across two independent rebuilds", () => {
    const events = groupFightScenario().events;

    const a = freshDb();
    insertEvents(a.db, events);
    rebuildProjections(a.db);

    const b = freshDb();
    insertEvents(b.db, events);
    rebuildProjections(b.db);

    expect(snapshotJson(a.db)).toBe(snapshotJson(b.db));
  });

  it("is stable when the same database is rebuilt twice", () => {
    const { db } = freshDb();
    insertEvents(db, groupFightScenario().events);
    rebuildProjections(db);
    const once = snapshotJson(db);
    rebuildProjections(db);
    expect(snapshotJson(db)).toBe(once);
  });
});
