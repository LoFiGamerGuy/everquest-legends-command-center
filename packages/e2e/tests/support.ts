/**
 * End-to-end test support (issue #21).
 *
 * Helpers for driving the FULL M1 chain from a real on-disk log file:
 *   temp log file → IngestPipeline → @eqlcc/database → projections → read API.
 * Plus deterministic dumps (raw event stream + every projection table) so the
 * suite can assert byte-identical equality across independent runs, resumes, and
 * incremental-vs-rebuild passes.
 */

import { migrate, openDatabase, type SqlDatabase, type LogFileInput } from "@eqlcc/database";
import { DIALECT_EQL_BETA_2026_07 } from "@eqlcc/event-schema";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { LOG_FILE_NAME } from "./golden-log.js";

/** A migrated in-memory database (the pipeline adds its resolver_snapshot table). */
export function freshDb(): SqlDatabase {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

/** Write `content` to a temp `eqlog_*.txt` (latin1, offsets == raw bytes) + a cleanup fn. */
export function writeTempLog(content: string): {
  dir: string;
  logPath: string;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eqlcc-e2e-"));
  const logPath = path.join(dir, LOG_FILE_NAME);
  fs.writeFileSync(logPath, Buffer.from(content, "latin1"));
  return { dir, logPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** LogFileInput for the synthetic golden file at `logPath` (owner Playerone/erudin). */
export function logFileInput(logPath: string): LogFileInput {
  return {
    path: logPath,
    characterName: "Playerone",
    server: "erudin",
    dialectId: DIALECT_EQL_BETA_2026_07,
  };
}

/**
 * A stored-event row projected to the fields that must be byte-identical across
 * runs. This intentionally dumps the WHOLE persisted row — including the
 * denormalized `source_entity_id`/`target_entity_id`/`value` columns and the
 * projection-written `session_id`/`encounter_id` FKs — so a regression in any of
 * them fails the determinism / resume comparisons, not just the raw parse fields.
 * The only columns omitted are the intentionally run-local identifiers `id`
 * (rowid) and `log_file_id`; canonical `seq` order carries the identity instead.
 * NOTE: `source_entity_id`/`target_entity_id`/`session_id`/`encounter_id` are
 * written by the projectors, so compare `allEvents` AFTER projections have run.
 */
export interface StoredEvent {
  seq: number;
  byteOffset: number;
  raw: string;
  ts: number;
  type: string;
  sourceEntityId: number | null;
  targetEntityId: number | null;
  value: number | null;
  sessionId: number | null;
  encounterId: number | null;
  dialectId: string;
  ruleId: string | null;
  payload: string;
}

/** The full events row for a log file in canonical (seq) order, as comparable rows. */
export function allEvents(db: SqlDatabase, logFileId: number): StoredEvent[] {
  return db
    .prepare(
      `SELECT seq, byte_offset AS byteOffset, raw, ts, type,
              source_entity_id AS sourceEntityId, target_entity_id AS targetEntityId,
              value, session_id AS sessionId, encounter_id AS encounterId,
              dialect_id AS dialectId, rule_id AS ruleId, payload
       FROM events WHERE log_file_id = ? ORDER BY seq`,
    )
    .all(logFileId) as StoredEvent[];
}

/** Count events for a log file. */
export function eventCount(db: SqlDatabase, logFileId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE log_file_id = ?")
    .get(logFileId) as { n: number };
  return row.n;
}

/**
 * Every projection table with a stable ordering key, so a JSON dump is
 * byte-comparable. `events_backfill` captures the session_id/encounter_id the
 * sessions/encounters projectors write back onto `events`, so determinism and
 * incremental==rebuild also cover the backfill, not just the derived tables.
 */
const SNAPSHOT_TABLES: ReadonlyArray<[string, string]> = [
  ["events_backfill", "ORDER BY id"],
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
    const from =
      table === "events_backfill"
        ? "SELECT id, session_id, encounter_id FROM events"
        : `SELECT * FROM ${table}`;
    out[table] = db.prepare(`${from} ${order}`).all();
  }
  return out;
}

/** Stable JSON of the full projection state for byte-identical comparison. */
export function snapshotJson(db: SqlDatabase): string {
  return JSON.stringify(snapshot(db));
}
