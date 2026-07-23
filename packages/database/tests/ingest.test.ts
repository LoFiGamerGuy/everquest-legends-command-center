import { describe, expect, it } from "vitest";

import { getWatermark, ingestEvents } from "../src/index.js";

import { freshDb, meleeHit, sampleBatch } from "./helpers.js";

function eventCount(db: ReturnType<typeof freshDb>["db"], logFileId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE log_file_id = ?")
    .get(logFileId) as { n: number };
  return row.n;
}

describe("ingestEvents", () => {
  it("appends events and advances the (byte_offset, seq) watermark in one call", () => {
    const { db, logFileId } = freshDb();
    const { events, watermark } = sampleBatch();

    const result = ingestEvents(db, logFileId, events, watermark);

    expect(result.inserted).toBe(3);
    expect(eventCount(db, logFileId)).toBe(3);
    expect(result.watermark).toEqual(watermark);
    expect(getWatermark(db, logFileId)).toEqual(watermark);

    // Denormalized value column mirrors the payload magnitude.
    const stored = db
      .prepare("SELECT seq, byte_offset AS byteOffset, value, type FROM events ORDER BY seq")
      .all() as { seq: number; byteOffset: number; value: number; type: string }[];
    expect(stored.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(stored.every((r) => r.type === "melee_hit" && r.value === 5)).toBe(true);
  });

  it("is idempotent: re-ingesting the SAME batch inserts zero rows and leaves the watermark unchanged", () => {
    // Headline acceptance test for issue #9.
    const { db, logFileId } = freshDb();
    const { events, watermark } = sampleBatch();

    const first = ingestEvents(db, logFileId, events, watermark);
    expect(first.inserted).toBe(3);
    const countAfterFirst = eventCount(db, logFileId);
    const watermarkAfterFirst = getWatermark(db, logFileId);

    const second = ingestEvents(db, logFileId, events, watermark);

    expect(second.inserted).toBe(0); // no duplicates
    expect(eventCount(db, logFileId)).toBe(countAfterFirst); // count unchanged
    expect(getWatermark(db, logFileId)).toEqual(watermarkAfterFirst); // watermark unchanged
    expect(second.watermark).toEqual(watermark);
  });

  it("round-trips the watermark (byteOffset + seq) for tailer resume", () => {
    const { db, logFileId } = freshDb();
    expect(getWatermark(db, logFileId)).toEqual({ byteOffset: 0, seq: 0 });

    // Line at byte 900 is 60 bytes long -> ends at 960, resume offset 961.
    ingestEvents(db, logFileId, [meleeHit(7, 900)], { byteOffset: 961, seq: 7 });

    expect(getWatermark(db, logFileId)).toEqual({ byteOffset: 961, seq: 7 });
  });

  it("advances the watermark forward-only and never regresses on replay of an older batch", () => {
    const { db, logFileId } = freshDb();
    const { events, watermark } = sampleBatch();
    ingestEvents(db, logFileId, events, watermark);

    // Replay the earlier line with ITS OWN justified watermark (161 < 281):
    // forward-only MAX must keep the higher watermark.
    ingestEvents(db, logFileId, [meleeHit(1, 100)], { byteOffset: 161, seq: 1 });

    expect(getWatermark(db, logFileId)).toEqual(watermark);
  });

  it("derives the watermark one byte past the last complete line when none is supplied", () => {
    const { db, logFileId } = freshDb();
    // Last line starts at 160, is 60 bytes long -> ends at 220, resume offset 221.
    const events = [meleeHit(1, 100), meleeHit(2, 160)];

    const result = ingestEvents(db, logFileId, events);

    expect(result.watermark).toEqual({ byteOffset: 221, seq: 2 });
  });

  it("throws on a seq collision at a different byte_offset and drops nothing (append-only)", () => {
    // BLOCKER 1: a duplicate seq at a NEW byte offset must not be silently
    // ignored; it violates UNIQUE(log_file_id, seq) and rolls the batch back.
    const { db, logFileId } = freshDb();
    const { events, watermark } = sampleBatch();
    ingestEvents(db, logFileId, events, watermark);
    const before = getWatermark(db, logFileId);
    const countBefore = eventCount(db, logFileId);

    // seq 3 already exists (byte 220); reuse seq 3 at a different byte offset.
    const collision = meleeHit(3, 500, {
      raw: "You pierce a dune spiderling for 5 points of damage. [dup seq3]",
    });
    expect(() => ingestEvents(db, logFileId, [collision])).toThrow();

    expect(eventCount(db, logFileId)).toBe(countBefore);
    expect(getWatermark(db, logFileId)).toEqual(before);
  });

  it("throws when a byte_offset duplicate carries mismatched provenance and moves nothing", () => {
    // BLOCKER (round 2): a row reusing an existing byte_offset but with a
    // different seq/raw must be rejected loudly (append-only provenance), not
    // silently absorbed while MAX(...) advances the watermark.
    const { db, logFileId } = freshDb();
    const { events, watermark } = sampleBatch();
    ingestEvents(db, logFileId, events, watermark);
    const before = getWatermark(db, logFileId);
    const countBefore = eventCount(db, logFileId);

    // byte 220 already holds seq 3; replay that offset with a higher seq and a
    // longer raw line.
    const rewritten = meleeHit(99, 220, {
      raw: "You pierce a dune spiderling for 5 points of damage. [rewritten, much longer line]",
    });
    expect(() => ingestEvents(db, logFileId, [rewritten])).toThrow(/different event|provenance/i);

    expect(eventCount(db, logFileId)).toBe(countBefore);
    expect(getWatermark(db, logFileId)).toEqual(before);
  });

  it("rejects a non-empty watermark for an empty batch and does not move the watermark", () => {
    // BLOCKER 2: nothing read cannot justify advancing the resume point.
    const { db, logFileId } = freshDb();
    const { events, watermark } = sampleBatch();
    ingestEvents(db, logFileId, events, watermark);
    const before = getWatermark(db, logFileId);

    expect(() => ingestEvents(db, logFileId, [], { byteOffset: 99999, seq: 99 })).toThrow(
      /empty batch/i,
    );
    expect(getWatermark(db, logFileId)).toEqual(before);
  });

  it("no-ops on an empty batch with no watermark", () => {
    const { db, logFileId } = freshDb();
    const result = ingestEvents(db, logFileId, []);
    expect(result.inserted).toBe(0);
    expect(result.watermark).toEqual({ byteOffset: 0, seq: 0 });
  });

  it("rejects an inflated watermark on a duplicate-only re-ingest (cannot skip unread bytes)", () => {
    // BLOCKER 2: a duplicate-only batch carrying a higher-than-justified
    // watermark must not advance past what the batch's rows justify.
    const { db, logFileId } = freshDb();
    const { events, watermark } = sampleBatch();
    ingestEvents(db, logFileId, events, watermark);
    const before = getWatermark(db, logFileId);

    // Same events (all duplicates) but claiming a far-ahead byte offset.
    expect(() => ingestEvents(db, logFileId, events, { byteOffset: 99999, seq: 3 })).toThrow(
      /not justified/i,
    );
    expect(getWatermark(db, logFileId)).toEqual(before);
  });

  it("is atomic: a failing insert rolls back the whole batch and leaves the watermark untouched", () => {
    const { db, logFileId } = freshDb();
    const { events, watermark } = sampleBatch();
    ingestEvents(db, logFileId, events, watermark);
    const before = getWatermark(db, logFileId);
    const countBefore = eventCount(db, logFileId);

    // logFileId 999 has no log_files row -> FK violation inside the tx.
    expect(() => ingestEvents(db, 999, [meleeHit(9, 999)])).toThrow();

    // The valid file's state is untouched; no partial writes leaked.
    expect(getWatermark(db, logFileId)).toEqual(before);
    expect(eventCount(db, logFileId)).toBe(countBefore);
    expect(eventCount(db, 999)).toBe(0);
  });
});
