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
  // `totalCopper` covers loot_auto_sell / coin_gain (money is a primary indexed
  // magnitude, DATA_MODEL.md §7).
  for (const key of ["amount", "percentMilli", "delta", "costPoints", "totalCopper", "value"]) {
    const candidate = record[key];
    if (typeof candidate === "number") return candidate;
  }
  return null;
}

/**
 * Extent of a batch: the byte offset just past the last complete line, and the
 * batch's maximum seq. The "last line" is the event with the greatest byte
 * offset (byte offsets and seq are co-monotonic per file). Byte length is
 * counted in the source's single-byte encoding (Windows-1252 ≈ latin1;
 * ARCHITECTURE.md §5), which equals the JS string length; `+1` accounts for the
 * `\n` terminator the tailer strips from `raw` (a `\r\n` log resumes one byte
 * early — a harmless idempotent re-read).
 */
interface BatchExtent {
  /** Byte offset just past the last complete line (i.e. the derived watermark offset). */
  pastLastLine: number;
  /** First byte of the last complete line + its content length (before the terminator). */
  lastLineContentEnd: number;
  /** Greatest seq in the batch. */
  maxSeq: number;
}

function batchExtent(events: readonly LogEvent[]): BatchExtent {
  let lastLineOffset = -1;
  let lastLineRaw = "";
  let maxSeq = 0;
  for (const event of events) {
    if (event.byteOffset > lastLineOffset) {
      lastLineOffset = event.byteOffset;
      lastLineRaw = event.raw;
    }
    if (event.seq > maxSeq) maxSeq = event.seq;
  }
  const contentEnd = lastLineOffset + Buffer.byteLength(lastLineRaw, "latin1");
  return { pastLastLine: contentEnd + 1, lastLineContentEnd: contentEnd, maxSeq };
}

const INSERT_EVENT_SQL = `INSERT INTO events
  (log_file_id, seq, byte_offset, raw, ts, type, value, payload, dialect_id, rule_id)
  VALUES (@logFileId, @seq, @byteOffset, @raw, @ts, @type, @value, @payload, @dialectId, @ruleId)
  ON CONFLICT(log_file_id, byte_offset) DO NOTHING`;

const ADVANCE_WATERMARK_SQL = `UPDATE log_files
  SET byte_offset = MAX(byte_offset, @byteOffset),
      seq         = MAX(seq, @seq),
      last_read_at = @now
  WHERE id = @id`;

/** Immutable provenance of an already-persisted event at a given byte offset. */
const EXISTING_EVENT_SQL = `SELECT seq, raw, ts, type, dialect_id AS dialectId, rule_id AS ruleId, payload
  FROM events WHERE log_file_id = ? AND byte_offset = ?`;

interface ExistingProvenance {
  seq: number;
  raw: string;
  ts: number;
  type: string;
  dialectId: string;
  ruleId: string | null;
  /** Serialized source-of-truth JSON (the full typed event). */
  payload: string;
}

/**
 * Append `events` for `logFileId` and advance its resume watermark, atomically.
 *
 * Insertion uses a targeted `ON CONFLICT(log_file_id, byte_offset) DO NOTHING`:
 * a genuine byte-offset replay is idempotent, but ANY other constraint
 * violation — notably a duplicate `seq` at a different byte offset — THROWS and
 * rolls the whole batch back, so a line can never be silently dropped
 * (append-only / lossless, ARCHITECTURE.md §4). Every event must be tagged for
 * `logFileId` (a cross-file event is rejected before any write, so the wrong
 * file's watermark can never move). When a byte-offset conflict suppresses a
 * row, the persisted line's immutable provenance (`seq`, `raw`, `ts`, `type`,
 * `dialect_id`, `rule_id`, and the serialized `payload`) must match the incoming
 * event — a rewritten line at an existing offset is rejected, not silently
 * absorbed.
 *
 * The watermark UPDATE must affect exactly one row; if it does not, the batch
 * rolls back so events are never committed without their watermark.
 *
 * The watermark only advances when justified by THIS batch:
 * - an empty batch never advances it (a non-empty explicit watermark for an
 *   empty batch is rejected — nothing read cannot move the resume point);
 * - an explicit watermark must be justified by the batch's own extent (its
 *   `seq` equals the batch max; its `byteOffset` sits at the end of the last
 *   line ±1 terminator byte), so a duplicate-only re-ingest carrying an inflated
 *   watermark cannot skip unread bytes;
 * - the update is forward-only (`MAX(...)`), so replaying an older batch never
 *   regresses the watermark.
 *
 * @param watermark Explicit resume position (production: the tailer's batch
 * watermark for `byteOffset` and the parser's last `seq`). When omitted it is
 * derived from the batch extent (max seq; one byte past the last complete line).
 */
export function ingestEvents(
  db: SqlDatabase,
  logFileId: number,
  events: readonly LogEvent[],
  watermark?: Watermark,
): IngestResult {
  // An empty batch justifies no watermark movement.
  if (events.length === 0) {
    if (watermark !== undefined) {
      throw new Error(
        "@eqlcc/database: refusing to advance the watermark for an empty batch " +
          "(no events read cannot justify moving the resume point).",
      );
    }
    return { inserted: 0, watermark: getWatermark(db, logFileId) };
  }

  // Cross-file guard: every event must belong to the file whose watermark we are
  // about to move. A batch tagged for another file would advance the wrong
  // resume point (and store the wrong file's provenance). Reject before any write.
  for (const event of events) {
    if (event.logFileId !== logFileId) {
      throw new Error(
        `@eqlcc/database: batch for log file ${logFileId} contains an event tagged log file ` +
          `${event.logFileId} (seq ${event.seq}); refusing to ingest across files.`,
      );
    }
  }

  const extent = batchExtent(events);
  const target = justifiedWatermark(extent, watermark);

  const insert = db.prepare(INSERT_EVENT_SQL);
  const existing = db.prepare(EXISTING_EVENT_SQL);
  const advance = db.prepare(ADVANCE_WATERMARK_SQL);

  const run = db.transaction((): number => {
    let inserted = 0;
    for (const event of events) {
      const ruleId = event.ruleId ?? null;
      // Serialize once; reuse for the insert bind AND the replay comparison so a
      // changed typed payload cannot slip through as "idempotent".
      const payload = JSON.stringify(event);
      const info = insert.run({
        logFileId,
        seq: event.seq,
        byteOffset: event.byteOffset,
        raw: event.raw,
        ts: event.ts,
        type: event.type,
        value: primaryValue(event),
        payload,
        dialectId: event.dialectId,
        ruleId,
      });
      if (info.changes === 1) {
        inserted += 1;
        continue;
      }
      // A byte-offset conflict suppressed the row (ON CONFLICT DO NOTHING). A
      // true replay is idempotent, but the persisted line's immutable provenance
      // MUST match — including the serialized payload (source-of-truth JSON) —
      // otherwise we'd silently absorb a rewritten line (and its watermark move)
      // at that offset. Reject the whole batch instead.
      const prior = existing.get(logFileId, event.byteOffset) as ExistingProvenance | undefined;
      if (
        prior === undefined ||
        prior.seq !== event.seq ||
        prior.raw !== event.raw ||
        prior.ts !== event.ts ||
        prior.type !== event.type ||
        prior.dialectId !== event.dialectId ||
        prior.ruleId !== ruleId ||
        prior.payload !== payload
      ) {
        throw new Error(
          `@eqlcc/database: byte offset ${event.byteOffset} in log file ${logFileId} already holds ` +
            `a different event (seq ${prior?.seq ?? "?"} vs ${event.seq}); refusing to silently ` +
            `overwrite append-only provenance.`,
        );
      }
    }
    const advanced = advance.run({
      id: logFileId,
      byteOffset: target.byteOffset,
      seq: target.seq,
      now: Date.now(),
    });
    // The invariant is events-and-watermark-together: if the watermark row did
    // not update (missing file row, or a driver not enforcing what we expect),
    // roll the whole batch back rather than commit events without a watermark.
    if (advanced.changes !== 1) {
      throw new Error(
        `@eqlcc/database: watermark update affected ${advanced.changes} rows for log file ` +
          `${logFileId} (expected 1); rolling back to preserve the events+watermark invariant.`,
      );
    }
    return inserted;
  });

  const inserted = run();
  return { inserted, watermark: getWatermark(db, logFileId) };
}

/**
 * Resolve the watermark to persist for a non-empty batch. Without an explicit
 * watermark the batch extent is used. An explicit watermark is accepted only if
 * justified by the batch: `seq` equals the batch max, and `byteOffset` lands at
 * the end of the last line (allowing 0–2 terminator bytes). Anything else is an
 * unjustified value that could skip unread bytes, so it throws.
 */
function justifiedWatermark(extent: BatchExtent, watermark?: Watermark): Watermark {
  if (watermark === undefined) {
    return { byteOffset: extent.pastLastLine, seq: extent.maxSeq };
  }
  if (watermark.seq !== extent.maxSeq) {
    throw new Error(
      `@eqlcc/database: watermark seq ${watermark.seq} is not justified by this batch ` +
        `(batch max seq is ${extent.maxSeq}).`,
    );
  }
  // Valid resume offsets sit one terminator past the last line: contentEnd+1
  // (`\n`) or contentEnd+2 (`\r\n`). Anything outside would skip unread bytes.
  if (
    watermark.byteOffset < extent.pastLastLine ||
    watermark.byteOffset > extent.pastLastLine + 1
  ) {
    throw new Error(
      `@eqlcc/database: watermark byteOffset ${watermark.byteOffset} is not justified by this ` +
        `batch (its last line ends at byte ${extent.lastLineContentEnd}, so the resume offset must be ` +
        `${extent.pastLastLine}–${extent.pastLastLine + 1}); refusing to skip unread bytes.`,
    );
  }
  return watermark;
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
