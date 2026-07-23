/**
 * Ingestion API (issue #9, ARCHITECTURE.md §5, DATA_MODEL.md §2).
 *
 * The core invariant: parsed events are appended to the append-only `events`
 * table AND the (byte_offset, seq) resume watermark on `log_files` is advanced
 * IN THE SAME TRANSACTION. Crash-safety therefore reduces to SQLite durability:
 * we either have the events and the advanced watermark, or neither.
 *
 * Re-ingestion is idempotent: `INSERT OR IGNORE` on `UNIQUE(log_file_id,
 * byte_offset)` drops duplicates, and the watermark advances forward-only
 * (`MAX(...)`), so replaying a batch inserts zero rows and never regresses the
 * watermark.
 */

import type { LogEvent } from "@eqlcc/event-schema";

import type { SqlDatabase } from "./db.js";

/** Resume position for a tracked log file (DATA_MODEL.md §2, Ordering amendment). */
export interface Watermark {
  /** Byte offset of the next byte to read (advanced forward-only). */
  byteOffset: number;
  /** Per-file monotonic emission ordinal reached (restored with byteOffset). */
  seq: number;
}

export interface IngestResult {
  /** Rows actually inserted (excludes idempotent duplicates). */
  inserted: number;
  /** The watermark as persisted after this call. */
  watermark: Watermark;
}

export interface LogFileInput {
  /** Absolute path (unique key). */
  path: string;
  characterName?: string | null;
  server?: string | null;
  /** Active parser dialect, e.g. 'eql-beta-2026-07'. */
  dialectId: string;
}

/**
 * Register (or update) a tracked log file, returning its id. Idempotent on
 * `path`. Callers use the returned id with {@link ingestEvents}.
 */
export function upsertLogFile(db: SqlDatabase, input: LogFileInput): number {
  const row = db
    .prepare(
      `INSERT INTO log_files (path, character_name, server, dialect_id, first_seen_at)
       VALUES (@path, @characterName, @server, @dialectId, @now)
       ON CONFLICT(path) DO UPDATE SET
         character_name = excluded.character_name,
         server         = excluded.server,
         dialect_id     = excluded.dialect_id
       RETURNING id`,
    )
    .get({
      path: input.path,
      characterName: input.characterName ?? null,
      server: input.server ?? null,
      dialectId: input.dialectId,
      now: Date.now(),
    }) as { id: number };
  return row.id;
}

/** Denormalized primary magnitude for indexing (must equal the payload value). */
function primaryValue(event: LogEvent): number | null {
  const record = event as unknown as Record<string, unknown>;
  for (const key of ["amount", "percentMilli", "delta", "costPoints", "value"]) {
    const candidate = record[key];
    if (typeof candidate === "number") return candidate;
  }
  return null;
}

/** Best-effort watermark from a batch when the caller does not supply one. */
function deriveWatermark(events: readonly LogEvent[]): Watermark | undefined {
  if (events.length === 0) return undefined;
  let byteOffset = 0;
  let seq = 0;
  for (const event of events) {
    byteOffset = Math.max(byteOffset, event.byteOffset + Buffer.byteLength(event.raw, "utf8"));
    seq = Math.max(seq, event.seq);
  }
  return { byteOffset, seq };
}

const INSERT_EVENT_SQL = `INSERT OR IGNORE INTO events
  (log_file_id, seq, byte_offset, raw, ts, type, value, payload, dialect_id, rule_id)
  VALUES (@logFileId, @seq, @byteOffset, @raw, @ts, @type, @value, @payload, @dialectId, @ruleId)`;

const ADVANCE_WATERMARK_SQL = `UPDATE log_files
  SET byte_offset = MAX(byte_offset, @byteOffset),
      seq         = MAX(seq, @seq),
      last_read_at = @now
  WHERE id = @id`;

/**
 * Append `events` for `logFileId` and advance its resume watermark, atomically.
 *
 * @param watermark Explicit resume position (production: the tailer's batch
 * watermark for `byteOffset` and the parser's last `seq`). When omitted it is
 * derived from the batch (max seq; max byte offset past each line) — a
 * best-effort fallback, since a re-read from a slightly short offset is
 * harmless (idempotent by the UNIQUE key).
 */
export function ingestEvents(
  db: SqlDatabase,
  logFileId: number,
  events: readonly LogEvent[],
  watermark?: Watermark,
): IngestResult {
  const insert = db.prepare(INSERT_EVENT_SQL);
  const advance = db.prepare(ADVANCE_WATERMARK_SQL);
  const target = watermark ?? deriveWatermark(events);

  const run = db.transaction((): number => {
    let inserted = 0;
    for (const event of events) {
      const info = insert.run({
        logFileId,
        seq: event.seq,
        byteOffset: event.byteOffset,
        raw: event.raw,
        ts: event.ts,
        type: event.type,
        value: primaryValue(event),
        payload: JSON.stringify(event),
        dialectId: event.dialectId,
        ruleId: event.ruleId ?? null,
      });
      inserted += info.changes;
    }
    if (target !== undefined) {
      advance.run({
        id: logFileId,
        byteOffset: target.byteOffset,
        seq: target.seq,
        now: Date.now(),
      });
    }
    return inserted;
  });

  const inserted = run();
  return { inserted, watermark: getWatermark(db, logFileId) };
}

/** Read the persisted resume watermark for a tracked file (tailer resume). */
export function getWatermark(db: SqlDatabase, logFileId: number): Watermark {
  const row = db
    .prepare("SELECT byte_offset AS byteOffset, seq AS seq FROM log_files WHERE id = ?")
    .get(logFileId) as { byteOffset: number; seq: number } | undefined;
  if (row === undefined) {
    throw new Error(`@eqlcc/database: no log_files row for id ${logFileId}`);
  }
  return { byteOffset: row.byteOffset, seq: row.seq };
}
