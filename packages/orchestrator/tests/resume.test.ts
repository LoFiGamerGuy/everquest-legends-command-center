import { afterEach, describe, expect, it } from "vitest";

import { DIALECT_EQL_BETA_2026_07 } from "@eqlcc/event-schema";

import { IngestPipeline, loadResolverSnapshot } from "../src/index.js";

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
  writeTempLog,
} from "./helpers.js";

import * as fs from "node:fs";

describe("IngestPipeline — durable resume determinism (issue #19 headline)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  /** Baseline: one uninterrupted replay of the whole file. */
  function uninterruptedRun() {
    const { logPath, cleanup } = writeTempLog(fullText());
    cleanups.push(cleanup);
    const db = freshDb();
    const pipeline = new IngestPipeline({ db, logFile: logFileInput(logPath) });
    pipeline.replay();
    return { db, logFileId: pipeline.logFileId, watermark: pipeline.watermark() };
  }

  it("kill-and-resume mid-file reproduces the single-run event set + watermark byte-identically, with no loss or duplication", () => {
    const baseline = uninterruptedRun();
    const baselineEvents = allEvents(baseline.db, baseline.logFileId);

    // Interrupted run against ITS OWN db, sharing the SAME on-disk path.
    const { logPath, cleanup } = writeTempLog(fullText().slice(0, cutOffset()));
    cleanups.push(cleanup);
    const db = freshDb();

    // Pass 1: crash after the prefix (only cutOffset() bytes exist on disk).
    const before = new IngestPipeline({ db, logFile: logFileInput(logPath) });
    const p1 = before.replay();
    expect(p1.linesProcessed).toBe(CUT_AFTER_LINE);
    expect(before.watermark()).toEqual({ byteOffset: cutOffset(), seq: CUT_AFTER_LINE });

    // "Restart": the rest of the file is now present on disk.
    fs.writeFileSync(logPath, Buffer.from(fullText(), "latin1"));

    // Pass 2: a FRESH pipeline against the SAME db resumes from the persisted watermark.
    const after = new IngestPipeline({ db, logFile: logFileInput(logPath) });
    // Resume point came from the DB, not from re-reading the file.
    expect(after.watermark()).toEqual({ byteOffset: cutOffset(), seq: CUT_AFTER_LINE });
    const p2 = after.replay();
    expect(p2.linesProcessed).toBe(LOG_LINES.length - CUT_AFTER_LINE);

    // No loss, no duplication: exactly one event per line.
    expect(eventCount(db, after.logFileId)).toBe(LOG_LINES.length);
    // seq is contiguous 1..N with no gaps or repeats.
    const resumedEvents = allEvents(db, after.logFileId);
    expect(resumedEvents.map((e) => e.seq)).toEqual(LOG_LINES.map((_, i) => i + 1));
    // Byte-identical to the uninterrupted run (seq, byte_offset, raw, ts, type,
    // dialect_id, rule_id, and full payload JSON all match).
    expect(resumedEvents).toEqual(baselineEvents);
    // Final watermark identical to the uninterrupted run.
    expect(after.watermark()).toEqual(baseline.watermark);
    expect(after.watermark()).toEqual({ byteOffset: fullSize(), seq: LOG_LINES.length });
  });

  it("restores the resolver snapshot on resume: a pet link established before the cut survives without re-reading it", () => {
    const { logPath, cleanup } = writeTempLog(fullText().slice(0, cutOffset()));
    cleanups.push(cleanup);
    const db = freshDb();

    // Pass 1 ingests the pet_chatter line (line 2, before the cut), which links
    // Petone -> Playerone.
    const before = new IngestPipeline({ db, logFile: logFileInput(logPath) });
    before.replay();
    expect(before.resolver.resolve("Petone").kind).toBe("pet");

    // A snapshot was persisted for this file.
    const snap = loadResolverSnapshot(db, before.logFileId);
    expect(snap?.entities.some((e) => e.canonical === "Petone")).toBe(true);

    // Restart with the full file present.
    fs.writeFileSync(logPath, Buffer.from(fullText(), "latin1"));
    const after = new IngestPipeline({ db, logFile: logFileInput(logPath) });

    // BEFORE processing any resumed line: the link is already present, and it can
    // ONLY have come from the restored snapshot — the establishing pet_chatter
    // line (before the cut) is never re-read on resume.
    const restored = after.resolver.resolve("Petone");
    expect(restored.kind).toBe("pet");
    expect(restored.ownerId).toBe("Playerone");

    // Finishing the file keeps the link (the post-cut Petone melee hits roll up).
    after.replay();
    const final = after.resolver.attributeSource({
      type: "melee_hit",
      attacker: "Petone",
      target: "a fire beetle",
      verb: "slashes",
      amount: 6,
      modifiers: [],
      ts: 0,
      seq: 999,
      raw: "probe",
      byteOffset: 0,
      lineNo: 0,
      logFileId: after.logFileId,
      dialectId: DIALECT_EQL_BETA_2026_07,
      ruleId: "melee-hit-third",
    });
    expect(final.rolledUp).toBe(true);
    expect(final.attributedId).toBe("Playerone");
  });

  it("idempotent re-ingestion: re-processing already-persisted bytes inserts nothing and changes nothing", () => {
    const { logPath, cleanup } = writeTempLog(fullText());
    cleanups.push(cleanup);
    const db = freshDb();

    const first = new IngestPipeline({ db, logFile: logFileInput(logPath) });
    const firstResult = first.replay();
    expect(firstResult.inserted).toBe(LOG_LINES.length);
    const eventsAfterFirst = allEvents(db, first.logFileId);
    const watermarkAfterFirst = first.watermark();

    // (a) A completed-file re-run is a natural no-op — resume is already at EOF.
    const rerun = new IngestPipeline({ db, logFile: logFileInput(logPath) });
    const rerunResult = rerun.replay();
    expect(rerunResult.inserted).toBe(0);
    expect(rerunResult.batches).toBe(0);
    expect(rerun.watermark()).toEqual(watermarkAfterFirst);

    // (b) Force a full re-read of the SAME bytes (rewind the watermark) to exercise
    // the ingestion idempotency guard directly: every line collides on
    // (log_file_id, byte_offset) and is dropped, none duplicated, content unchanged.
    db.prepare("UPDATE log_files SET byte_offset = 0, seq = 0 WHERE id = ?").run(first.logFileId);
    const reread = new IngestPipeline({ db, logFile: logFileInput(logPath) });
    const rereadResult = reread.replay();
    expect(rereadResult.linesProcessed).toBe(LOG_LINES.length); // all bytes re-processed
    expect(rereadResult.inserted).toBe(0); // but zero rows inserted (idempotent)
    expect(eventCount(db, reread.logFileId)).toBe(LOG_LINES.length); // no duplicates
    expect(allEvents(db, reread.logFileId)).toEqual(eventsAfterFirst); // byte-identical
    expect(reread.watermark()).toEqual(watermarkAfterFirst); // watermark restored
  });
});
