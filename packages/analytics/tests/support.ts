/**
 * Test support: a migrated in-memory DB, direct event insertion (mirroring what
 * ingestion writes — id in log order, full payload JSON), and a deterministic
 * snapshot of every projection table for byte-identical comparison.
 *
 * Fixtures are SYNTHETIC multi-actor scenarios (no real player logs; none exist,
 * none may be committed — CLAUDE.md).
 */

import { DIALECT_EQL_BETA_2026_07 } from "@eqlcc/event-schema";
import type { LogEvent } from "@eqlcc/event-schema";
import { migrate, openDatabase, upsertLogFile, type SqlDatabase } from "@eqlcc/database";

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

/** Insert events in order (rowid == log order per file), as ingestion would. */
export function insertEvents(db: SqlDatabase, events: readonly LogEvent[]): void {
  const stmt = db.prepare(
    `INSERT INTO events (log_file_id, seq, byte_offset, raw, ts, type, value, payload, dialect_id, rule_id)
     VALUES (@logFileId, @seq, @byteOffset, @raw, @ts, @type, NULL, @payload, @dialectId, @ruleId)`,
  );
  const tx = db.transaction(() => {
    for (const e of events) {
      stmt.run({
        logFileId: e.logFileId,
        seq: e.seq,
        byteOffset: e.byteOffset,
        raw: e.raw,
        ts: e.ts,
        type: e.type,
        payload: JSON.stringify(e),
        dialectId: e.dialectId,
        ruleId: e.ruleId ?? null,
      });
    }
  });
  tx();
}

/** Projection tables with a stable ordering key for deterministic snapshots. */
const SNAPSHOT_TABLES: ReadonlyArray<[string, string]> = [
  ["entities", "ORDER BY id"],
  ["entity_links", "ORDER BY id"],
  ["sessions", "ORDER BY id"],
  ["zones", "ORDER BY id"],
  ["zone_visits", "ORDER BY id"],
  ["encounters", "ORDER BY id"],
  ["encounter_participants", "ORDER BY encounter_id, entity_id"],
  ["encounter_actor_stats", "ORDER BY encounter_id, entity_id"],
  ["encounter_buckets", "ORDER BY encounter_id, entity_id, bucket_ts"],
  ["xp_events", "ORDER BY id"],
  ["aa_events", "ORDER BY id"],
  ["loot_events", "ORDER BY id"],
  ["currency_ledger", "ORDER BY id"],
  ["faction_events", "ORDER BY id"],
  ["skill_events", "ORDER BY id"],
  ["projection_state", "ORDER BY projector"],
];

export type Snapshot = Record<string, unknown[]>;

/** All projection-table rows, ordered deterministically (for equality asserts). */
export function snapshot(db: SqlDatabase): Snapshot {
  const out: Snapshot = {};
  for (const [table, order] of SNAPSHOT_TABLES) {
    out[table] = db.prepare(`SELECT * FROM ${table} ${order}`).all();
  }
  return out;
}

/** Stable JSON of a snapshot for byte-identical comparison. */
export function snapshotJson(db: SqlDatabase): string {
  return JSON.stringify(snapshot(db));
}
