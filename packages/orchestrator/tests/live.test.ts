import { afterEach, describe, expect, it } from "vitest";

import { IngestPipeline } from "../src/index.js";

import {
  CUT_AFTER_LINE,
  LOG_LINES,
  allEvents,
  cutOffset,
  eventCount,
  freshDb,
  fullSize,
  fullText,
  logFileInput,
  waitFor,
  writeTempLog,
} from "./helpers.js";

import * as fs from "node:fs";

describe("IngestPipeline — live mode", () => {
  const cleanups: (() => void)[] = [];
  const pipelines: IngestPipeline[] = [];
  afterEach(() => {
    for (const p of pipelines.splice(0)) p.stop();
    for (const c of cleanups.splice(0)) c();
  });

  /** Byte-identical event rows a replay of the complete file produces (baseline). */
  function replayBaseline() {
    const { logPath, cleanup } = writeTempLog(fullText());
    cleanups.push(cleanup);
    const db = freshDb();
    const pipeline = new IngestPipeline({ db, logFile: logFileInput(logPath) });
    pipeline.replay();
    return allEvents(db, pipeline.logFileId);
  }

  it("tails a growing file and agrees byte-for-byte with a replay of the final file", async () => {
    const baseline = replayBaseline();

    // Start live against a file that only holds the prefix so far.
    const { logPath, cleanup } = writeTempLog(fullText().slice(0, cutOffset()));
    cleanups.push(cleanup);
    const db = freshDb();
    const live = new IngestPipeline({
      db,
      logFile: logFileInput(logPath),
      tailer: { pollIntervalMs: 5, useFsWatch: false }, // poll-only: deterministic in tests
    });
    pipelines.push(live);

    live.startLive();

    // The prefix is ingested as the tailer polls.
    await waitFor(() => live.watermark().byteOffset === cutOffset());
    expect(eventCount(db, live.logFileId)).toBe(CUT_AFTER_LINE);

    // The game "writes more": append the remaining lines.
    fs.appendFileSync(logPath, Buffer.from(fullText().slice(cutOffset()), "latin1"));

    // The tailer picks up the growth and ingests the rest.
    await waitFor(() => live.watermark().byteOffset === fullSize());

    live.stop();

    expect(eventCount(db, live.logFileId)).toBe(LOG_LINES.length);
    expect(live.watermark()).toEqual({ byteOffset: fullSize(), seq: LOG_LINES.length });
    // Live ingestion of a growing file == replay of the finished file, byte-for-byte.
    expect(allEvents(db, live.logFileId)).toEqual(baseline);
  });

  it("resumes live tailing from the persisted watermark after a clean stop", async () => {
    const baseline = replayBaseline();

    const { logPath, cleanup } = writeTempLog(fullText());
    cleanups.push(cleanup);
    const db = freshDb();

    // First live session: stop it after the prefix is ingested.
    const first = new IngestPipeline({
      db,
      logFile: logFileInput(logPath),
      tailer: { pollIntervalMs: 5, useFsWatch: false },
    });
    pipelines.push(first);
    first.startLive();
    await waitFor(() => first.watermark().byteOffset >= cutOffset());
    first.stop();
    const stoppedAt = first.watermark();
    expect(stoppedAt.byteOffset).toBeGreaterThanOrEqual(cutOffset());

    // Second live session resumes from the DB watermark — no loss, no duplication.
    const second = new IngestPipeline({
      db,
      logFile: logFileInput(logPath),
      tailer: { pollIntervalMs: 5, useFsWatch: false },
    });
    pipelines.push(second);
    expect(second.watermark()).toEqual(stoppedAt);
    second.startLive();
    await waitFor(() => second.watermark().byteOffset === fullSize());
    second.stop();

    expect(eventCount(db, second.logFileId)).toBe(LOG_LINES.length);
    expect(allEvents(db, second.logFileId)).toEqual(baseline);
  });
});
