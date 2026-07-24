import { DIALECT_EQL_BETA_2026_07 } from "@eqlcc/event-schema";
import { afterEach, describe, expect, it } from "vitest";

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

/** Probe: attribute a Petone melee hit and report whether it rolls up to an owner. */
function petAttribution(pipeline: IngestPipeline) {
  return pipeline.resolver.attributeSource({
    type: "melee_hit",
    attacker: "Petone",
    target: "a fire beetle",
    verb: "slashes",
    amount: 6,
    modifiers: [],
    ts: 0,
    seq: 10_000,
    raw: "probe",
    byteOffset: 0,
    lineNo: 0,
    logFileId: pipeline.logFileId,
    dialectId: DIALECT_EQL_BETA_2026_07,
    ruleId: "melee-hit-third",
  });
}

describe("IngestPipeline — resolver rebuild from events when no usable snapshot (HIGH 1 / MEDIUM 4)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  /** Baseline: one uninterrupted replay; return its events + the Petone attribution. */
  function baseline() {
    const { logPath, cleanup } = writeTempLog(fullText());
    cleanups.push(cleanup);
    const db = freshDb();
    const pipeline = new IngestPipeline({ db, logFile: logFileInput(logPath) });
    pipeline.replay();
    return { events: allEvents(db, pipeline.logFileId), attribution: petAttribution(pipeline) };
  }

  /**
   * Drive a mid-file crash so the DB holds lines 1..CUT with a nonzero watermark,
   * then damage the snapshot via `damage` and return the resumed pipeline (fresh
   * instance against the same DB + full file).
   */
  function crashThenDamageSnapshot(damage: (db: ReturnType<typeof freshDb>, logFileId: number) => void) {
    const { logPath, cleanup } = writeTempLog(fullText().slice(0, cutOffset()));
    cleanups.push(cleanup);
    const db = freshDb();

    const before = new IngestPipeline({ db, logFile: logFileInput(logPath) });
    before.replay();
    expect(before.watermark()).toEqual({ byteOffset: cutOffset(), seq: CUT_AFTER_LINE });
    // The pet link IS in the snapshot at this point (established by the pre-cut
    // pet_chatter line); damaging it forces the rebuild-from-events path.
    expect(loadResolverSnapshot(db, before.logFileId)).toBeDefined();

    damage(db, before.logFileId);

    fs.writeFileSync(logPath, Buffer.from(fullText(), "latin1"));
    return { db, logPath, logFileId: before.logFileId };
  }

  const damagers: [string, (db: ReturnType<typeof freshDb>, id: number) => void][] = [
    ["deleted", (db, id) => db.prepare("DELETE FROM resolver_snapshot WHERE log_file_id = ?").run(id)],
    ["version-mismatched", (db, id) => db.prepare("UPDATE resolver_snapshot SET version = 999 WHERE log_file_id = ?").run(id)],
    ["corrupt JSON", (db, id) => db.prepare("UPDATE resolver_snapshot SET snapshot = '{not json' WHERE log_file_id = ?").run(id)],
    ["malformed shape", (db, id) => db.prepare("UPDATE resolver_snapshot SET snapshot = '{\"version\":1}' WHERE log_file_id = ?").run(id)],
    // Outer-valid but nested-invalid: passes loadResolverSnapshot's shallow shape
    // check, then throws inside EntityResolver.fromSnapshot/cloneEntity. buildResolver
    // must catch and fall back to rebuild-from-events (MAJOR round-2), not wedge init.
    ["nested-invalid", (db, id) => db.prepare('UPDATE resolver_snapshot SET snapshot = \'{"version":1,"owner":{},"entities":[{}]}\' WHERE log_file_id = ?').run(id)],
  ];

  for (const [label, damage] of damagers) {
    it(`resumes by rebuilding resolver state from persisted events (${label} snapshot), never wedging init`, () => {
      const base = baseline();
      const { db, logPath, logFileId } = crashThenDamageSnapshot(damage);

      // The damaged snapshot is discarded (no throw), so init() must have REBUILT
      // the resolver by replaying persisted events 1..CUT through a fresh resolver.
      const resumed = new IngestPipeline({ db, logFile: logFileInput(logPath) });

      // BEFORE processing any resumed line: the pre-watermark pet link is present,
      // and it can only have come from replaying the persisted events (the snapshot
      // is unusable and the establishing pet_chatter line is never re-read).
      const restored = resumed.resolver.resolve("Petone");
      expect(restored.kind).toBe("pet");
      expect(restored.ownerId).toBe("Playerone");

      // Finish the file: events are byte-identical to the uninterrupted run and the
      // post-cut Petone hits roll up to the owner exactly as the baseline does.
      resumed.replay();
      expect(eventCount(db, logFileId)).toBe(LOG_LINES.length);
      expect(allEvents(db, logFileId)).toEqual(base.events);
      expect(resumed.watermark()).toEqual({ byteOffset: fullSize(), seq: LOG_LINES.length });

      const attribution = petAttribution(resumed);
      expect(attribution.rolledUp).toBe(true);
      expect(attribution.attributedId).toBe("Playerone");
      expect(attribution.attributedId).toBe(base.attribution.attributedId);
    });
  }

  it("a fresh DB (watermark 0) with no snapshot starts a fresh resolver, not a rebuild", () => {
    const { logPath, cleanup } = writeTempLog(fullText());
    cleanups.push(cleanup);
    const db = freshDb();
    const pipeline = new IngestPipeline({ db, logFile: logFileInput(logPath) });
    // Nothing ingested yet → only the owner entity exists (no rebuild ran).
    expect(pipeline.resolver.list()).toHaveLength(1);
    expect(pipeline.resolver.resolve("Petone").kind).toBe("unknown");
  });
});
