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

    ingestEvents(db, logFileId, [meleeHit(7, 900)], { byteOffset: 960, seq: 7 });

    expect(getWatermark(db, logFileId)).toEqual({ byteOffset: 960, seq: 7 });
  });

  it("advances the watermark forward-only and never regresses on replay of an older batch", () => {
    const { db, logFileId } = freshDb();
    const { events, watermark } = sampleBatch();
    ingestEvents(db, logFileId, events, watermark);

    // Replay an earlier batch with a lower watermark — must not move backwards.
    ingestEvents(db, logFileId, [meleeHit(1, 100)], { byteOffset: 50, seq: 1 });

    expect(getWatermark(db, logFileId)).toEqual(watermark);
  });

  it("derives a monotonic watermark from the batch when none is supplied", () => {
    const { db, logFileId } = freshDb();
    const events = [meleeHit(1, 100), meleeHit(2, 160)];

    const result = ingestEvents(db, logFileId, events);

    expect(result.watermark.seq).toBe(2);
    expect(result.watermark.byteOffset).toBeGreaterThanOrEqual(160);
  });

  it("is atomic: a failing insert rolls back the whole batch and leaves the watermark untouched", () => {
    const { db, logFileId } = freshDb();
    const { events, watermark } = sampleBatch();
    ingestEvents(db, logFileId, events, watermark);
    const before = getWatermark(db, logFileId);
    const countBefore = eventCount(db, logFileId);

    // logFileId 999 has no log_files row -> FK violation inside the tx.
    expect(() => ingestEvents(db, 999, [meleeHit(9, 999)], { byteOffset: 9999, seq: 9 })).toThrow();

    // The valid file's state is untouched; no partial writes leaked.
    expect(getWatermark(db, logFileId)).toEqual(before);
    expect(eventCount(db, logFileId)).toBe(countBefore);
    expect(eventCount(db, 999)).toBe(0);
  });
});
