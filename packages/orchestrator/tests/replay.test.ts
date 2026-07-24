import { afterEach, describe, expect, it } from "vitest";

import { IngestPipeline } from "../src/index.js";

import {
  EXPECTED_TYPES,
  LOG_LINES,
  allEvents,
  eventCount,
  freshDb,
  fullSize,
  fullText,
  logFileInput,
  writeTempLog,
} from "./helpers.js";

describe("IngestPipeline — replay mode", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  function setup() {
    const { logPath, cleanup } = writeTempLog(fullText());
    cleanups.push(cleanup);
    const db = freshDb();
    return { db, logPath };
  }

  it("replays a multi-line synthetic log into the expected events and final watermark", () => {
    const { db, logPath } = setup();
    const pipeline = new IngestPipeline({ db, logFile: logFileInput(logPath) });

    const result = pipeline.replay();

    // Every complete line became exactly one event (nothing dropped, incl. raw_unknown).
    expect(result.linesProcessed).toBe(LOG_LINES.length);
    expect(eventCount(db, pipeline.logFileId)).toBe(LOG_LINES.length);

    const events = allEvents(db, pipeline.logFileId);
    expect(events.map((e) => e.type)).toEqual(EXPECTED_TYPES);
    // seq is per-file monotonic 1..N.
    expect(events.map((e) => e.seq)).toEqual(LOG_LINES.map((_, i) => i + 1));

    // The unmatched line is retained as raw_unknown with a NULL rule_id.
    const rawUnknown = events.filter((e) => e.type === "raw_unknown");
    expect(rawUnknown).toHaveLength(1);
    expect(rawUnknown[0]?.ruleId).toBeNull();

    // Final watermark sits one byte past the last complete line (EOF here).
    expect(result.watermark).toEqual({ byteOffset: fullSize(), seq: LOG_LINES.length });
    expect(pipeline.watermark()).toEqual({ byteOffset: fullSize(), seq: LOG_LINES.length });
  });

  it("is deterministic across batch boundaries: a tiny chunk size yields byte-identical rows", () => {
    const { db: dbBig, logPath } = setup();
    const big = new IngestPipeline({ db: dbBig, logFile: logFileInput(logPath) });
    big.replay();

    const dbSmall = freshDb();
    const small = new IngestPipeline({
      db: dbSmall,
      logFile: logFileInput(logPath),
      replayChunkBytes: 32, // forces many partial reads / multi-batch commits
    });
    const smallResult = small.replay();

    expect(smallResult.batches).toBeGreaterThan(1);
    // Same events, byte-for-byte, regardless of how bytes were chunked into batches.
    expect(allEvents(dbSmall, small.logFileId)).toEqual(allEvents(dbBig, big.logFileId));
    expect(small.watermark()).toEqual(big.watermark());
  });

  it("refuses to drive one instance in two modes", () => {
    const { db, logPath } = setup();
    const pipeline = new IngestPipeline({ db, logFile: logFileInput(logPath) });
    pipeline.replay();
    expect(() => pipeline.startLive()).toThrow(/already in 'replay' mode/i);
  });
});
