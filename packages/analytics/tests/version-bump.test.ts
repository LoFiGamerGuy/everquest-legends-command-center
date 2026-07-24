/**
 * Version bump ⇒ clean rebuild (docs/PROJECTIONS_SPEC.md §9.3): bumping a leaf
 * projector's stored version wipes exactly its table and rebuilds it from 0,
 * leaving other projectors untouched.
 *
 * We simulate a version bump by mutating `projection_state.version` for the
 * `encounter_buckets` projector (a leaf) below/above what the code declares, then
 * running `updateProjections` — the driver must detect the mismatch, reset only
 * that projector, and reproduce identical rows.
 */

import { describe, expect, it } from "vitest";

import { rebuildProjections, updateProjections } from "../src/index.js";
import { groupFightScenario } from "./fixtures.js";
import { freshDb, insertEvents, snapshot, snapshotJson } from "./support.js";

describe("version bump", () => {
  it("wipes and rebuilds exactly the bumped projector, leaving others untouched", () => {
    const { db } = freshDb();
    insertEvents(db, groupFightScenario().events);
    rebuildProjections(db);
    const before = snapshotJson(db);

    // Capture the untouched tables' rows to prove isolation.
    const sessionsBefore = JSON.stringify(snapshot(db).sessions);
    const encountersBefore = JSON.stringify(snapshot(db).encounters);

    // Force a stored-version mismatch for the buckets projector and corrupt its
    // table, then re-run: the driver should reset+rebuild only buckets.
    db.prepare("UPDATE projection_state SET version = version + 1 WHERE projector = 'encounter_buckets'").run();
    db.prepare("UPDATE encounter_buckets SET damage = damage + 9999").run();

    updateProjections(db);

    const after = snapshot(db);
    // Buckets rebuilt to correct values (corruption gone) and version realigned.
    expect(snapshotJson(db)).toBe(before);
    expect(JSON.stringify(after.sessions)).toBe(sessionsBefore);
    expect(JSON.stringify(after.encounters)).toBe(encountersBefore);
    const stateRows = (after.projection_state ?? []) as { projector: string; version: number; last_event_id: number }[];
    const bucketsState = stateRows.find((r) => r.projector === "encounter_buckets");
    expect(bucketsState?.version).toBe(1);
    expect(bucketsState?.last_event_id).toBeGreaterThan(0);
  });

  it("cascades a non-leaf bump to downstream projectors so they re-derive", () => {
    const { db } = freshDb();
    insertEvents(db, groupFightScenario().events);
    rebuildProjections(db);
    const before = snapshotJson(db);

    // Bump `encounters` (a foundational projector): its dependents
    // (encounter_actor_stats, encounter_buckets, and encounter-referencing domain
    // rows) must re-derive, not keep stale head watermarks. Corrupt all three to
    // prove they are actually rebuilt.
    db.prepare("UPDATE projection_state SET version = version + 1 WHERE projector = 'encounters'").run();
    db.prepare("UPDATE encounter_actor_stats SET damage_total = damage_total + 5000").run();
    db.prepare("UPDATE encounter_buckets SET damage = damage + 5000").run();

    updateProjections(db);

    // Full state restored: downstream re-derived consistently against the same
    // (deterministically re-created) encounter ids.
    expect(snapshotJson(db)).toBe(before);

    const state = (snapshot(db).projection_state ?? []) as {
      projector: string;
      version: number;
      last_event_id: number;
    }[];
    for (const name of ["encounters", "encounter_actor_stats", "encounter_buckets", "domain"]) {
      const row = state.find((r) => r.projector === name);
      expect(row?.last_event_id).toBeGreaterThan(0); // re-applied to head
    }
    expect(state.find((r) => r.projector === "encounters")?.version).toBe(1);
  });
});
