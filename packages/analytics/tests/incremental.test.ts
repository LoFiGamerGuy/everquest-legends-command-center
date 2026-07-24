/**
 * Incremental == rebuild (docs/PROJECTIONS_SPEC.md §9.2) — the headline
 * projection_state watermark-correctness guarantee.
 *
 * Applying the events in ARBITRARY batch splits via `updateProjections` (with a
 * fresh process each time, i.e. every projector reconstructing its state from
 * the DB) must equal a single full `rebuildProjections`. We compare the full
 * projection-table snapshot, ids included.
 */

import { describe, expect, it } from "vitest";

import { rebuildProjections, updateProjections } from "../src/index.js";
import { groupFightScenario } from "./fixtures.js";
import { freshDb, insertEvents, snapshotJson } from "./support.js";

/** Ingest `events` in the given contiguous chunk sizes, updating after each. */
function incrementalSnapshot(sizes: number[]): string {
  const events = groupFightScenario().events;
  const { db } = freshDb();
  let offset = 0;
  for (const size of sizes) {
    const chunk = events.slice(offset, offset + size);
    offset += size;
    if (chunk.length === 0) continue;
    insertEvents(db, chunk);
    updateProjections(db);
  }
  // Any trailing events beyond the declared sizes.
  if (offset < events.length) {
    insertEvents(db, events.slice(offset));
    updateProjections(db);
  }
  return snapshotJson(db);
}

function rebuildSnapshot(): string {
  const { db } = freshDb();
  insertEvents(db, groupFightScenario().events);
  rebuildProjections(db);
  return snapshotJson(db);
}

describe("incremental == rebuild", () => {
  const rebuilt = rebuildSnapshot();
  const total = groupFightScenario().events.length;

  it("equals a single rebuild when applied one event at a time", () => {
    expect(incrementalSnapshot(new Array<number>(total).fill(1))).toBe(rebuilt);
  });

  it("equals a single rebuild for an uneven split straddling the AFK gap", () => {
    // 8 | 3 | rest — boundaries mid-encounter and across the session gap.
    expect(incrementalSnapshot([8, 3])).toBe(rebuilt);
  });

  it("equals a single rebuild for several arbitrary splits", () => {
    for (const sizes of [[5, 5, 7], [1, 13, 3], [10, 1, 1, 5], [16, 1]]) {
      expect(incrementalSnapshot(sizes)).toBe(rebuilt);
    }
  });

  it("a single-batch update from empty also equals rebuild", () => {
    expect(incrementalSnapshot([total])).toBe(rebuilt);
  });
});
