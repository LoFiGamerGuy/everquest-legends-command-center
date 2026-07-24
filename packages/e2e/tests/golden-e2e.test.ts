/**
 * Golden end-to-end suite (issue #21, E1.1).
 *
 * Drives the FULL M1 chain over one rich synthetic multi-actor log:
 *
 *   synthetic log file
 *     → @eqlcc/orchestrator  IngestPipeline.replay   (parser + resolver + durable watermark)
 *     → @eqlcc/database      append-only events + resume watermark
 *     → @eqlcc/analytics     rebuildProjections / updateProjections + finalizeEncounters
 *     → @eqlcc/analytics     read API (sessions / encounters / actor-stats / experiment)
 *
 * and asserts the end-to-end invariants the milestone rests on:
 *   1. read-API sanity across the whole chain;
 *   2. full-pipeline determinism (run twice → byte-identical events + projections);
 *   3. kill-and-resume determinism (crash mid-file, resume on the same DB → identical
 *      events + projections + watermark to an uninterrupted run; no loss / no dup);
 *   4. idempotent re-replay of a completed file is a no-op;
 *   5. incremental == rebuild (staged replay + updateProjections in batches == one rebuild);
 *   6. attribution correctness (the headline real-world risk): the pet's damage folds
 *      to its owner, and the NAMED enemy that hits back is never the top actor and is
 *      never booked as ally DPS.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { IngestPipeline } from "@eqlcc/orchestrator";
import type { SqlDatabase } from "@eqlcc/database";
import {
  finalizeEncounters,
  getActorStats,
  getEncounter,
  getExperimentBreakdown,
  getSessionSummary,
  getSessions,
  listEncounters,
  rebuildProjections,
  updateProjections,
} from "@eqlcc/analytics";

import * as fs from "node:fs";

import {
  CUT_AFTER_LINE,
  EXPECTED_TYPES,
  LOG_LINES,
  UNMATCHED_LINES,
  cutOffset,
  fullSize,
  fullText,
  offsetOfLine,
} from "./golden-log.js";
import {
  allEvents,
  eventCount,
  freshDb,
  logFileInput,
  snapshotJson,
  writeTempLog,
  type StoredEvent,
} from "./support.js";

/** Run projections the identical way everywhere (rebuild + terminal close). */
function project(db: SqlDatabase): void {
  rebuildProjections(db);
  finalizeEncounters(db);
}

/** Full uninterrupted chain over `logPath` into a fresh DB; returns handles. */
function runFullChain(logPath: string): { db: SqlDatabase; logFileId: number } {
  const db = freshDb();
  const pipeline = new IngestPipeline({ db, logFile: logFileInput(logPath) });
  pipeline.replay();
  project(db);
  return { db, logFileId: pipeline.logFileId };
}

/** Look up an entity id by its canonical name (unique per projection DB). */
function entityId(db: SqlDatabase, name: string): number {
  const row = db.prepare("SELECT id FROM entities WHERE canonical_name = ?").get(name) as
    | { id: number }
    | undefined;
  if (row === undefined) throw new Error(`entity not found: ${name}`);
  return row.id;
}

describe("golden end-to-end (issue #21)", () => {
  let logPath = "";
  let cleanup = (): void => {};

  beforeAll(() => {
    const t = writeTempLog(fullText());
    logPath = t.logPath;
    cleanup = t.cleanup;
  });
  afterAll(() => cleanup());

  // ── 1. Read-API sanity across the whole chain ────────────────────────────────

  it("parses the whole log and answers the read API sanely", () => {
    const db = freshDb();
    const pipeline = new IngestPipeline({ db, logFile: logFileInput(logPath) });
    const res = pipeline.replay();

    // Every line became exactly one event, in the expected type sequence.
    expect(res.linesProcessed).toBe(LOG_LINES.length);
    expect(pipeline.watermark()).toEqual({ byteOffset: fullSize(), seq: LOG_LINES.length });
    const events = allEvents(db, pipeline.logFileId);
    expect(events.map((e) => e.type)).toEqual([...EXPECTED_TYPES]);

    // Exactly the two flavour lines are unmatched (raw_unknown), no more no less.
    const unknownSeqs = events.filter((e) => e.type === "raw_unknown").map((e) => e.seq);
    expect(unknownSeqs).toEqual([...UNMATCHED_LINES]);

    project(db);

    // The AFK gap (> 30 min) split the log into two sessions.
    const sessions = getSessions(db);
    expect(sessions.length).toBe(2);

    // Two encounters: the named boss, then a trash pull.
    const encs = listEncounters(db);
    expect(encs.map((e) => e.name)).toEqual([
      "Venril Sathir",
      "Trash: The Northern Desert of Ro",
    ]);

    // Session 1 summary: one encounter, XP + coin + zone all attributed.
    const s1 = getSessionSummary(db, sessions[0]!.id)!;
    expect(s1.encounterCount).toBe(1);
    expect(s1.xpPercentMilli).toBe(4000);
    expect(s1.coinCopper).toBe(43); // auto-sell 18c + coin_gain 25c
    expect(s1.zones).toEqual(["Karnor's Castle"]);
    expect(s1.activeMs).toBe(10_000);
    expect(s1.afkMs).toBe(25_000);

    // Experiment breakdown reports honest n and REFUSES a winner below minimum n.
    const exp = getExperimentBreakdown(db, { dimension: "stance", metric: "dps" });
    expect(exp.minN).toBe(8);
    expect(exp.groups.length).toBeGreaterThanOrEqual(1);
    expect(exp.groups.every((g) => g.n >= 1)).toBe(true);
    expect(exp.winner).toBeNull();
    expect(exp.winnerRefusedReason).toBeTruthy();
  });

  // ── 2. Full-pipeline determinism ─────────────────────────────────────────────

  it("is deterministic: two independent full runs are byte-identical", () => {
    const a = runFullChain(logPath);
    const b = runFullChain(logPath);

    // Identical raw event stream (seq, byte_offset, raw, ts, type, dialect, rule, payload).
    expect(allEvents(a.db, a.logFileId)).toEqual(allEvents(b.db, b.logFileId));
    // Identical projection state across every table + the events backfill.
    expect(snapshotJson(a.db)).toBe(snapshotJson(b.db));
  });

  // ── 3. Kill-and-resume determinism (the headline durability guarantee) ───────

  it("kill-and-resume at multiple committed watermarks reproduces the uninterrupted run", () => {
    // Baseline: one uninterrupted run (projected).
    const baseline = runFullChain(logPath);
    const baselineEvents = allEvents(baseline.db, baseline.logFileId);

    // Interrupted run against its OWN db, sharing a private on-disk path. We
    // "crash" at TWO distinct committed watermarks (after 12 lines, then after
    // 20), not just once at a clean EOF. Because the pipeline commits each batch
    // (events + watermark) atomically, a real kill can only ever leave the DB at
    // a committed batch boundary — never a torn/partial row past the watermark —
    // so resuming from an on-disk watermark at several such boundaries is the
    // faithful crash-recovery model. We assert the committed row count equals the
    // watermark at each stage to prove nothing past it leaked in.
    const CUT1 = CUT_AFTER_LINE; // 12
    const CUT2 = 20;
    const prefix = writeTempLog(fullText().slice(0, offsetOfLine(CUT1 + 1)));
    const db = freshDb();

    // Pass 1: only the first CUT1 lines exist on disk — "crash" after CUT1.
    const p1pipe = new IngestPipeline({ db, logFile: logFileInput(prefix.logPath) });
    const p1 = p1pipe.replay();
    expect(p1.linesProcessed).toBe(CUT1);
    expect(p1pipe.watermark()).toEqual({ byteOffset: offsetOfLine(CUT1 + 1), seq: CUT1 });
    expect(eventCount(db, p1pipe.logFileId)).toBe(CUT1); // committed == watermark, no torn rows

    // Restart 1: grow the file to CUT2 lines, resume, then "crash" again mid-stream.
    fs.writeFileSync(
      prefix.logPath,
      Buffer.from(fullText().slice(0, offsetOfLine(CUT2 + 1)), "latin1"),
    );
    const p2pipe = new IngestPipeline({ db, logFile: logFileInput(prefix.logPath) });
    expect(p2pipe.watermark()).toEqual({ byteOffset: offsetOfLine(CUT1 + 1), seq: CUT1 });
    const p2 = p2pipe.replay();
    expect(p2.linesProcessed).toBe(CUT2 - CUT1);
    expect(p2pipe.watermark()).toEqual({ byteOffset: offsetOfLine(CUT2 + 1), seq: CUT2 });
    expect(eventCount(db, p2pipe.logFileId)).toBe(CUT2);

    // Restart 2: the rest of the file is now on disk; resume to EOF.
    fs.writeFileSync(prefix.logPath, Buffer.from(fullText(), "latin1"));
    const after = new IngestPipeline({ db, logFile: logFileInput(prefix.logPath) });
    expect(after.watermark()).toEqual({ byteOffset: offsetOfLine(CUT2 + 1), seq: CUT2 });
    const p3 = after.replay();
    expect(p3.linesProcessed).toBe(LOG_LINES.length - CUT2);

    // No loss, no duplication: exactly one event per line, seq contiguous 1..N.
    expect(eventCount(db, after.logFileId)).toBe(LOG_LINES.length);
    const resumedSeqs = allEvents(db, after.logFileId).map((e) => e.seq);
    expect(resumedSeqs).toEqual(LOG_LINES.map((_, i) => i + 1));
    expect(after.watermark()).toEqual({ byteOffset: fullSize(), seq: LOG_LINES.length });

    // Full-row event stream (incl. resolved entity FKs + projected session/encounter)
    // and every projection table identical to the uninterrupted run — compared
    // AFTER projections run on both sides so the downstream-written columns count.
    project(db);
    const resumed: StoredEvent[] = allEvents(db, after.logFileId);
    expect(resumed).toEqual(baselineEvents);
    expect(snapshotJson(db)).toBe(snapshotJson(baseline.db));

    prefix.cleanup();
  });

  // ── 4. Idempotent re-replay of a completed file is a no-op ────────────────────

  it("re-replaying a completed file inserts nothing and changes no projection", () => {
    const { db, logFileId } = runFullChain(logPath);
    const before = allEvents(db, logFileId);
    const beforeProjections = snapshotJson(db);
    const beforeWatermark = { byteOffset: fullSize(), seq: LOG_LINES.length };

    // A fresh pipeline on the SAME db resumes from head → reads to EOF, inserts 0.
    const again = new IngestPipeline({ db, logFile: logFileInput(logPath) });
    expect(again.watermark()).toEqual(beforeWatermark);
    const res = again.replay();
    expect(res.inserted).toBe(0);
    expect(again.watermark()).toEqual(beforeWatermark);
    expect(allEvents(db, logFileId)).toEqual(before);

    // updateProjections at head is a no-op too.
    updateProjections(db);
    finalizeEncounters(db);
    expect(snapshotJson(db)).toBe(beforeProjections);
  });

  // ── 5. Incremental == rebuild, end-to-end ────────────────────────────────────

  it("staged replay + incremental updateProjections in batches == one full rebuild", () => {
    // Reference: full replay + one rebuild.
    const ref = runFullChain(logPath);

    // Incremental: replay the file in two stages, catching projections up after
    // each stage in small batches, then terminal-close once. Batch sizes are
    // chosen to force UNEVEN splits with a trailing remainder in BOTH stages
    // (stage 1 = 12 events / batch 5 → 5,5,2; stage 2 = 15 events / batch 4 →
    // 4,4,4,3), so a remainder-batch boundary landing mid-encounter is exercised,
    // not just clean multiples of the batch size.
    const prefix = writeTempLog(fullText().slice(0, cutOffset()));
    const db = freshDb();

    const stage1 = new IngestPipeline({ db, logFile: logFileInput(prefix.logPath) });
    stage1.replay();
    updateProjections(db, { batchSize: 5 });

    fs.writeFileSync(prefix.logPath, Buffer.from(fullText(), "latin1"));
    const stage2 = new IngestPipeline({ db, logFile: logFileInput(prefix.logPath) });
    stage2.replay();
    updateProjections(db, { batchSize: 4 });
    finalizeEncounters(db);

    expect(snapshotJson(db)).toBe(snapshotJson(ref.db));
    prefix.cleanup();
  });

  // ── 6. Attribution correctness (the headline real-world risk) ────────────────

  describe("attribution through the whole chain", () => {
    let db: SqlDatabase;

    beforeAll(() => {
      db = runFullChain(logPath).db;
    });

    it("folds the pet's damage to its owner (foldPets)", () => {
      const enc = listEncounters(db).find((e) => e.name === "Venril Sathir")!;
      const owner = entityId(db, "Playerone");
      const pet = entityId(db, "Pettwo");

      // Per-actor: the pet keeps its own row, attributed to the owner.
      const perActor = getActorStats(db, { encounterId: enc.id, foldPets: false });
      const petRow = perActor.rows.find((r) => r.entityId === pet)!;
      expect(petRow.attribOwnerId).toBe(owner);
      expect(petRow.damageTotal).toBe(31); // pet melee 20 + pet damage-shield 11

      // Folded: the pet's 31 rolls into the owner (owner melee 95 + pet 31 = 126),
      // and the pet no longer has a standalone folded row.
      const folded = getActorStats(db, { encounterId: enc.id, foldPets: true });
      const ownerFolded = folded.rows.find((r) => r.entityId === owner)!;
      expect(ownerFolded.damageTotal).toBe(126);
      expect(folded.rows.some((r) => r.entityId === pet)).toBe(false);
      expect(folded.provenance.minConfidence).toBeGreaterThan(0);
    });

    it("never books the named enemy that hits back as an actor / top actor / ally", () => {
      const enc = listEncounters(db).find((e) => e.name === "Venril Sathir")!;
      const boss = entityId(db, "Venril Sathir");

      // The boss's own 25 + 18 damage is never booked as actor-stats.
      const bookedForBoss = db
        .prepare("SELECT COUNT(*) AS c FROM encounter_actor_stats WHERE entity_id = ?")
        .get(boss) as { c: number };
      expect(bookedForBoss.c).toBe(0);

      // The top actor is the owner (an ally), never the enemy.
      expect(enc.topActorName).toBe("Playerone");
      expect(enc.topActorEntityId).not.toBe(boss);

      // The boss is a participant, classified as the ENEMY.
      const detail = getEncounter(db, enc.id)!;
      const bossPart = detail.participants.find((p) => p.entityId === boss)!;
      expect(bossPart.role).toBe("enemy");

      // The boss appears in NEITHER the per-actor NOR the folded actor rows.
      expect(detail.actors.rows.some((r) => r.entityId === boss)).toBe(false);
      expect(detail.actorsFolded.rows.some((r) => r.entityId === boss)).toBe(false);
    });

    it("excludes a trash mob that hits back, keeping the owner as top actor", () => {
      const trash = listEncounters(db).find((e) => e.name?.startsWith("Trash:"))!;
      const beetle = entityId(db, "a fire beetle");
      expect(trash.topActorName).toBe("Playerone");
      const booked = db
        .prepare("SELECT COUNT(*) AS c FROM encounter_actor_stats WHERE entity_id = ?")
        .get(beetle) as { c: number };
      expect(booked.c).toBe(0);
    });
  });
});
