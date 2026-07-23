import { DIALECT_EQL_BETA_2026_07 } from "@eqlcc/event-schema";
import type { MeleeHitEvent } from "@eqlcc/event-schema";

import { migrate, openDatabase, upsertLogFile, type SqlDatabase } from "../src/index.js";

/** A migrated in-memory database with one tracked log file (id returned). */
export function freshDb(): { db: SqlDatabase; logFileId: number } {
  const db = openDatabase(":memory:");
  migrate(db);
  const logFileId = upsertLogFile(db, {
    path: "/logs/eqlog_Playerone_erudin.txt",
    characterName: "Playerone",
    server: "erudin",
    dialectId: DIALECT_EQL_BETA_2026_07,
  });
  return { db, logFileId };
}

/** Build a verified-shape melee_hit event with the given provenance. */
export function meleeHit(
  seq: number,
  byteOffset: number,
  overrides: Partial<MeleeHitEvent> = {},
): MeleeHitEvent {
  return {
    type: "melee_hit",
    attacker: "Playerone",
    target: "a dune spiderling",
    verb: "pierce",
    amount: 5,
    modifiers: [],
    ts: 1752900000000 + seq * 1000,
    seq,
    raw: `You pierce a dune spiderling for 5 points of damage. [seq ${seq}]`,
    byteOffset,
    lineNo: seq,
    logFileId: 1,
    dialectId: DIALECT_EQL_BETA_2026_07,
    ruleId: "melee-hit-1",
    ...overrides,
  };
}

/**
 * A three-event batch with monotonic seq/byte offsets, plus its resume
 * watermark. Each raw line is 60 bytes; the last line starts at byte 220, so it
 * ends at 280 and the resume offset (one `\n` past it) is 281.
 */
export function sampleBatch(): { events: MeleeHitEvent[]; watermark: { byteOffset: number; seq: number } } {
  const events = [meleeHit(1, 100), meleeHit(2, 160), meleeHit(3, 220)];
  return { events, watermark: { byteOffset: 281, seq: 3 } };
}
