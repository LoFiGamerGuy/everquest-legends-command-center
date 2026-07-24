/**
 * IngestPipeline — the headless ingestion orchestrator (issue #19).
 *
 * Wires the four M1 packages into a working, durably-resumable pipeline:
 *
 *   log-tailer (bytes -> complete lines + offsets)
 *     -> log-parser (line -> typed LogEvent with seq/byteOffset provenance)
 *     -> EntityResolver.observe (maintain pet/attribution state)
 *     -> database.ingestEvents (append events + advance watermark, transactional)
 *
 * Two modes share one core (see {@link IngestPipeline.commit}):
 *   - replay(): process a whole existing file start->finish, deterministically,
 *     then stop. Reads only COMPLETE (newline-terminated) lines, exactly like
 *     the live tailer, so replay and live agree on the watermark.
 *   - startLive(): tail the file and ingest as it grows; clean start/stop.
 *
 * Durable resume (the headline): on construction the resume point is read from
 * getWatermark(byte_offset, seq); tailing/reading starts there and the parser's
 * seq counter is seeded with startSeq. Because ingestEvents is transactional and
 * idempotent on (log_file_id, byte_offset), restarting mid-file loses and
 * duplicates nothing — a re-run of an already-ingested batch inserts zero rows
 * and never regresses the watermark.
 *
 * Resolver-snapshot persistence: the resolver snapshot is written in the SAME
 * transaction as each event batch + watermark advance (see resolver-store), so
 * attribution state (pet links, user assertions, evidence) is always exactly as
 * fresh as the watermark and survives a restart without re-reading the file. If a
 * resume finds NO usable snapshot (absent/version-mismatched/corrupt) at a nonzero
 * watermark, attribution state is rebuilt by replaying the already-persisted
 * events through a fresh resolver (see buildResolver) so it never diverges. The
 * parser's lastTs is likewise re-seeded from the last persisted event so a
 * malformed-timestamp line right after the resume point keeps the uninterrupted ts.
 *
 * Explicitly OUT OF SCOPE (separate tickets): derived projections / sessions /
 * encounters / DPS rollups and events.source_entity_id/target_entity_id FK
 * backfill (#20); analytics (#21); any UI. This pipeline only makes the append-
 * only event stream + watermark + resolver snapshot durable end-to-end.
 */

import {
  getWatermark,
  ingestEvents,
  migrate,
  openDatabase,
  upsertLogFile,
  type LogFileInput,
  type SqlDatabase,
  type Watermark,
} from "@eqlcc/database";
import {
  ENTITY_KINDS,
  type EntityKind,
  type LogEvent,
  type RawUnknownEvent,
} from "@eqlcc/event-schema";
import {
  EntityResolver,
  LineSplitter,
  LogParser,
  parseTimestamp,
  type RawLine,
  type RecognizerRegistry,
} from "@eqlcc/log-parser";
import {
  LogTailer,
  decodeLine,
  type LineBatch,
  type LogEncoding,
  type LogTailerOptions,
  type TruncationEvent,
} from "@eqlcc/log-tailer";

import * as fs from "node:fs";
import * as path from "node:path";

import {
  ensureResolverSnapshotTable,
  loadResolverSnapshot,
  saveResolverSnapshot,
} from "./resolver-store.js";

/** Which driving mode a pipeline instance has been committed to. */
export type PipelineMode = "idle" | "replay" | "live";

export interface IngestPipelineOptions {
  /** An already-open database. If omitted, one is opened at {@link IngestPipelineOptions.dbPath}. */
  db?: SqlDatabase;
  /** Path for a database to open when {@link IngestPipelineOptions.db} is not given. Default `:memory:`. */
  dbPath?: string;
  /** The log file to track (absolute path + dialect; optional character/server). */
  logFile: LogFileInput;
  /** Override the recognizer registry (dialect selection). Default: latest known. */
  registry?: RecognizerRegistry;
  /** Bytes per read/batch in replay mode. Default 64 KiB. */
  replayChunkBytes?: number;
  /** Line decoding; offsets always count raw bytes. Default `"windows-1252"`. */
  encoding?: LogEncoding;
  /** LogTailer options for live mode. */
  tailer?: LogTailerOptions;
  /** Notified when the tailer detects truncation/rotation in live mode (live HALTS; see class doc). */
  onTruncation?: (info: TruncationEvent) => void;
  /**
   * Live mode: notified when a batch commit (or the tailer consumer path) throws.
   * The pipeline STOPS itself before calling this (see startLive) — a throwing
   * commit would otherwise be retried forever by the tailer with the watermark
   * frozen (corruption-safe via rollback, but an invisible liveness wedge).
   */
  onConsumerError?: (error: Error) => void;
  /** Live mode: notified of a (non-fatal, informational) tailer file-I/O `error`. Tailing continues. */
  onError?: (error: Error) => void;
}

/** Result of committing one batch (events + watermark + resolver snapshot). */
export interface BatchOutcome {
  /** Rows actually inserted (excludes idempotent duplicates). */
  inserted: number;
  /** The persisted watermark after this batch. */
  watermark: Watermark;
  /** Number of events parsed in this batch (== lines, including raw_unknown). */
  events: number;
}

/** Result of a full replay pass. */
export interface ReplayResult {
  /** Batches committed. */
  batches: number;
  /** Complete lines processed (== events appended, including raw_unknown). */
  linesProcessed: number;
  /** Rows actually inserted across the run (excludes idempotent duplicates). */
  inserted: number;
  /** The final persisted watermark. */
  watermark: Watermark;
}

/** A line handed to the shared commit core; `overflow` marks tailer memory-safety fragments. */
interface PipelineLine extends RawLine {
  /** True for tailer overflow fragments, which MUST be booked as raw_unknown, never recognized. */
  overflow?: boolean;
}

/** Coerce a parsed event to raw_unknown, preserving provenance (used for overflow fragments). */
function toRawUnknown(event: LogEvent): RawUnknownEvent {
  return {
    type: "raw_unknown",
    ts: event.ts,
    seq: event.seq,
    raw: event.raw,
    byteOffset: event.byteOffset,
    lineNo: event.lineNo,
    logFileId: event.logFileId,
    dialectId: event.dialectId,
    ruleId: null,
  };
}

export class IngestPipeline {
  private readonly options: IngestPipelineOptions;
  private readonly encoding: LogEncoding;
  private readonly replayChunkBytes: number;

  private dbHandle: SqlDatabase | undefined;
  private parser: LogParser | undefined;
  private resolverInstance: EntityResolver | undefined;
  private logFileIdValue = -1;
  private startOffset = 0;
  private startSeq = 0;
  private initialized = false;
  private mode: PipelineMode = "idle";
  private tailer: LogTailer | undefined;
  /**
   * Mirror of the parser's internal `lastTs` (the last valid timestamp seen).
   * The parser cannot be seeded with it across a restart, so we track it here —
   * seeded from the DB on resume — and patch malformed-timestamp lines in the
   * cold resume prefix so their `ts` matches an uninterrupted run (HIGH 2).
   */
  private carryTs = 0;
  /** The terminal error that halted this pipeline (live commit/consumer failure or truncation), if any. */
  private lastErrorValue: Error | undefined;

  constructor(options: IngestPipelineOptions) {
    this.options = options;
    this.encoding = options.encoding ?? "windows-1252";
    this.replayChunkBytes = options.replayChunkBytes ?? 64 * 1024;
    if (!Number.isSafeInteger(this.replayChunkBytes) || this.replayChunkBytes <= 0) {
      throw new RangeError(`replayChunkBytes must be a positive integer, got ${this.replayChunkBytes}`);
    }
  }

  /**
   * Open/migrate the DB, register the log file, resolve the resume point, seed
   * the parser seq, and restore the resolver snapshot (or start a fresh resolver
   * from the file name). Idempotent: called automatically by replay()/startLive().
   */
  init(): void {
    if (this.initialized) return;
    const db = this.options.db ?? openDatabase(this.options.dbPath ?? ":memory:");
    // Base schema via the central forward-only migration chain...
    migrate(db);
    // ...then the resolver_snapshot cache table, created idempotently OUTSIDE the
    // migration chain so it never bumps schema_version past the central registry
    // (which would make @eqlcc/database's migrate(db) refuse to open the DB). See
    // resolver-store module doc; #20 formalizes it as a numbered migration.
    ensureResolverSnapshotTable(db);

    const logFileId = upsertLogFile(db, this.options.logFile);
    const watermark = getWatermark(db, logFileId);

    const parser = new LogParser({
      logFileId,
      startSeq: watermark.seq,
      ...(this.options.registry === undefined ? {} : { registry: this.options.registry }),
    });

    this.dbHandle = db;
    this.logFileIdValue = logFileId;
    this.startOffset = watermark.byteOffset;
    this.startSeq = watermark.seq;
    this.parser = parser;
    this.resolverInstance = this.buildResolver(db, logFileId, watermark);
    // Seed the ts-carry from the last persisted event so a malformed-ts line right
    // after the resume point gets the same ts an uninterrupted replay would (HIGH 2).
    this.carryTs = this.lastPersistedTs(db, logFileId);
    this.initialized = true;
  }

  /**
   * Build the resolver for the resume point. Prefer the persisted snapshot; if
   * there is no USABLE snapshot AND we are resuming past offset 0, REBUILD
   * attribution state by replaying the already-persisted events through a fresh
   * resolver, so resume does not permanently diverge from an uninterrupted run
   * (HIGH 1). A fresh DB (watermark 0) just starts a fresh resolver.
   *
   * "Usable" is defensive at BOTH layers: loadResolverSnapshot rejects absent /
   * version-mismatched / unparseable / outer-malformed rows, and fromSnapshot is
   * additionally wrapped in try/catch here so a parseable-but-nested-invalid blob
   * (e.g. an entity missing its evidence arrays, which throws inside cloneEntity)
   * ALSO falls back to rebuild-from-events instead of wedging init. The table is a
   * rebuildable cache, so discarding on any restore failure is strictly safe.
   */
  private buildResolver(db: SqlDatabase, logFileId: number, watermark: Watermark): EntityResolver {
    const snapshot = loadResolverSnapshot(db, logFileId);
    if (snapshot !== undefined) {
      try {
        return EntityResolver.fromSnapshot(snapshot);
      } catch {
        // Nested-invalid snapshot: discard and fall through to rebuild-from-events.
      }
    }
    const resolver = EntityResolver.forLogFile(path.basename(this.options.logFile.path), logFileId);
    if (watermark.seq > 0 || watermark.byteOffset > 0) {
      this.rebuildResolverFromEvents(db, logFileId, resolver, watermark.seq);
    }
    return resolver;
  }

  /**
   * Rebuild resolver attribution state by replaying every persisted event up to
   * (and including) `throughSeq` in canonical (seq) order through `resolver`.
   * Durable user corrections (entity_overrides) are applied FIRST so the replayed
   * heuristics can never downgrade a user assertion (the resolver locks user
   * calls; see EntityResolver.applyKind). A corrupt payload row is skipped rather
   * than allowed to wedge init.
   */
  private rebuildResolverFromEvents(
    db: SqlDatabase,
    logFileId: number,
    resolver: EntityResolver,
    throughSeq: number,
  ): void {
    this.applyEntityOverrides(db, resolver);
    const rows = db
      .prepare("SELECT payload FROM events WHERE log_file_id = ? AND seq <= ? ORDER BY seq")
      .all(logFileId, throughSeq) as { payload: string }[];
    for (const row of rows) {
      let event: LogEvent;
      try {
        event = JSON.parse(row.payload) as LogEvent;
      } catch {
        continue; // a corrupt stored payload must not wedge the rebuild
      }
      resolver.observe(event);
    }
  }

  /**
   * Apply durable user corrections (DATA_MODEL.md `entity_overrides`) to the
   * resolver as locking user assertions. Entities are global (not per-file), so
   * every override naming a known entity is applied. `merge_into` is an
   * entity-merge projection concern (#20) and is skipped here.
   */
  private applyEntityOverrides(db: SqlDatabase, resolver: EntityResolver): void {
    const rows = db
      .prepare(
        `SELECT eo.field AS field, eo.new_value AS newValue,
                e.canonical_name AS name, owner_e.canonical_name AS ownerName
         FROM entity_overrides eo
         JOIN entities e ON e.id = eo.entity_id
         LEFT JOIN entities owner_e
           ON eo.field = 'owner' AND owner_e.id = CAST(eo.new_value AS INTEGER)
         ORDER BY eo.id`,
      )
      .all() as { field: string; newValue: string; name: string; ownerName: string | null }[];
    for (const row of rows) {
      if (row.field === "kind" && (ENTITY_KINDS as readonly string[]).includes(row.newValue)) {
        resolver.setEntityKind(row.name, row.newValue as EntityKind, { asserted: true });
      } else if (row.field === "owner" && row.ownerName !== null) {
        resolver.setPetOwner(row.name, row.ownerName, { asserted: true });
      }
    }
  }

  /** The `ts` of the last persisted event (== the parser's lastTs at the resume boundary), or 0. */
  private lastPersistedTs(db: SqlDatabase, logFileId: number): number {
    const row = db
      .prepare("SELECT ts FROM events WHERE log_file_id = ? ORDER BY seq DESC LIMIT 1")
      .get(logFileId) as { ts: number } | undefined;
    return row?.ts ?? 0;
  }

  /** The open database handle (after init). */
  get db(): SqlDatabase {
    this.ensureInit();
    return this.dbHandle as SqlDatabase;
  }

  /** The tracked file's `log_files.id` (after init). */
  get logFileId(): number {
    this.ensureInit();
    return this.logFileIdValue;
  }

  /** The live resolver (after init) — restored from snapshot on resume. */
  get resolver(): EntityResolver {
    this.ensureInit();
    return this.resolverInstance as EntityResolver;
  }

  /** Current driving mode. */
  get currentMode(): PipelineMode {
    return this.mode;
  }

  /**
   * The terminal error that halted this pipeline, or undefined. Set when live mode
   * stops on a commit/consumer failure or when either mode halts on truncation, so
   * a silent halt is inspectable even when no error callback was supplied (LOW 5).
   */
  get lastError(): Error | undefined {
    return this.lastErrorValue;
  }

  /** Read the persisted resume watermark from the database. */
  watermark(): Watermark {
    return getWatermark(this.db, this.logFileId);
  }

  /**
   * Replay mode: read the tracked file from the resume watermark to EOF,
   * committing complete lines in chunk-sized batches, then stop. Deterministic
   * and synchronous. Safe to call once per instance; a second call throws.
   */
  replay(): ReplayResult {
    this.ensureInit();
    this.assertMode("replay");

    const splitter = new LineSplitter(this.startOffset, this.startSeq + 1);
    let batches = 0;
    let linesProcessed = 0;
    let inserted = 0;

    const fd = fs.openSync(this.options.logFile.path, "r");
    try {
      const size = fs.fstatSync(fd).size;
      // Truncation/rotation guard (ARCHITECTURE.md §5.2): a file shorter than our
      // resume offset was truncated or replaced. Replay HALTS and surfaces it,
      // consistent with live mode (MEDIUM 3): silently resetting to offset 0 here
      // would let the forward-only DB watermark (MAX(...)) lag a prefix-only
      // resolver snapshot and later skip bytes. An explicit atomic rotation reset
      // of watermark + snapshot together is #20 territory.
      if (size < this.startOffset) {
        const info: TruncationEvent = {
          path: this.options.logFile.path,
          previousWatermark: this.startOffset,
          newLength: size,
        };
        this.lastErrorValue = new Error(
          `@eqlcc/orchestrator: replay halted — ${info.path} shrank to ${size} bytes below the ` +
            `resume offset ${this.startOffset} (truncation/rotation); rotation reset is #20.`,
        );
        this.options.onTruncation?.(info);
        return { batches: 0, linesProcessed: 0, inserted: 0, watermark: this.watermark() };
      }

      let pos = this.startOffset;
      const buffer = Buffer.allocUnsafe(this.replayChunkBytes);
      while (pos < size) {
        const want = Math.min(this.replayChunkBytes, size - pos);
        const read = fs.readSync(fd, buffer, 0, want, pos);
        if (read <= 0) break;
        pos += read;
        const text = decodeLine(buffer.subarray(0, read), this.encoding);
        const rawLines = splitter.feed(text);
        if (rawLines.length === 0) continue;
        // splitter.watermark is the offset just past the last COMPLETE line in
        // this batch — exactly the resume offset to persist.
        const outcome = this.commit(rawLines, splitter.watermark);
        batches += 1;
        linesProcessed += outcome.events;
        inserted += outcome.inserted;
      }
      // Note: an unterminated trailing line is intentionally NOT flushed — replay
      // consumes complete lines only, so the watermark never advances into a
      // partially-written line (matches the tailer's contract).
    } finally {
      fs.closeSync(fd);
    }

    return { batches, linesProcessed, inserted, watermark: this.watermark() };
  }

  /**
   * Live mode: tail the file from the resume watermark and ingest each tailer
   * batch as the file grows. Non-blocking; call {@link IngestPipeline.stop} to
   * release timers/watchers. Safe to call once per instance; a second call throws.
   */
  startLive(): void {
    this.ensureInit();
    this.assertMode("live");
    const tailer = new LogTailer(this.options.logFile.path, this.options.tailer ?? {});
    tailer.on("lines", (batch: LineBatch) => this.ingestTailerBatch(batch));
    tailer.on("truncated", (info: TruncationEvent) => {
      // Live mode HALTS on truncation/rotation. Resetting the DB watermark +
      // parser/resolver to re-read from offset 0 is #20 rotation-reset territory;
      // until then we STOP cleanly and surface it, rather than let the tailer
      // re-read offset 0 into a provenance-rejecting commit that would then wedge
      // on retry. Stopping here bumps the tailer generation so the current pass
      // does not proceed to re-read the reset offset.
      this.lastErrorValue = new Error(
        `@eqlcc/orchestrator: live tailing halted — ${info.path} was truncated/rotated ` +
          `(shrank to ${info.newLength} bytes below watermark ${info.previousWatermark}); ` +
          `rotation reset is #20.`,
      );
      this.stop();
      this.options.onTruncation?.(info);
    });
    tailer.on("consumer-error", (error: Error) => {
      // A batch commit threw (e.g. a genuine append-only provenance rejection).
      // The tailer has already rewound and would otherwise RETRY THE IDENTICAL
      // FAILING BATCH FOREVER with the watermark frozen (corruption-safe via
      // rollback, but an invisible liveness wedge). Stop to break the spin, then
      // surface it to the caller.
      this.lastErrorValue = error;
      this.stop();
      this.options.onConsumerError?.(error);
    });
    tailer.on("error", (error: Error) => {
      // Informational tailer file-I/O error; the tailer retries transient cases
      // itself and never aborts on this channel, so we only surface it.
      this.options.onError?.(error);
    });
    this.tailer = tailer;
    // firstLineNo = startSeq + 1 keeps tailer lineNo in lockstep with parser seq.
    tailer.start(this.startOffset, this.startSeq + 1);
  }

  /** Stop live tailing and release all handles/timers. Idempotent; no-op in replay/idle. */
  stop(): void {
    if (this.tailer !== undefined) {
      this.tailer.stop();
      this.tailer = undefined;
    }
  }

  // ── Shared core ─────────────────────────────────────────────────────────────

  private ingestTailerBatch(batch: LineBatch): void {
    const lines: PipelineLine[] = batch.lines.map((line) => ({
      raw: line.line,
      byteOffset: line.byteOffset,
      lineNo: line.lineNo,
      ...(line.overflow === true ? { overflow: true } : {}),
    }));
    this.commit(lines, batch.watermark);
  }

  /**
   * Parse a batch of complete lines, feed the resolver, and persist events +
   * watermark + resolver snapshot in ONE transaction (the atomicity contract in
   * resolver-store). Returns the batch outcome.
   */
  private commit(lines: PipelineLine[], watermarkOffset: number): BatchOutcome {
    const parser = this.parser as LogParser;
    const resolver = this.resolverInstance as EntityResolver;
    const db = this.dbHandle as SqlDatabase;

    if (lines.length === 0) {
      return { inserted: 0, watermark: getWatermark(db, this.logFileIdValue), events: 0 };
    }

    const events: LogEvent[] = [];
    for (const line of lines) {
      let event = parser.parseLine(line);
      // Overflow fragments start/end mid-line: never let a recognizer classify
      // them (log-tailer contract). Keep the parser-owned seq monotonic.
      if (line.overflow === true && event.type !== "raw_unknown") {
        event = toRawUnknown(event);
      }
      // ts-carry (HIGH 2): a line with no valid timestamp always becomes
      // raw_unknown, and the parser assigns it the parser's internal lastTs —
      // which starts cold (0) after a restart. We mirror lastTs ourselves (seeded
      // from the DB at init) and patch the cold-prefix malformed-ts lines so their
      // ts matches an uninterrupted replay byte-for-byte. Valid-ts lines advance
      // the carry exactly as the parser advances its lastTs.
      const parsedTs = parseTimestamp(event.raw);
      if (parsedTs === null) {
        if (event.type === "raw_unknown" && event.ts !== this.carryTs) {
          event = { ...event, ts: this.carryTs };
        }
      } else {
        this.carryTs = parsedTs;
      }
      events.push(event);
      resolver.observe(event);
    }

    // Events are co-monotonic in seq with their order, so the last carries the
    // batch's max seq — the seq half of the resume watermark.
    const lastEvent = events[events.length - 1] as LogEvent;
    const watermark: Watermark = { byteOffset: watermarkOffset, seq: lastEvent.seq };

    const run = db.transaction((): BatchOutcome => {
      const result = ingestEvents(db, this.logFileIdValue, events, watermark);
      saveResolverSnapshot(db, this.logFileIdValue, resolver.toSnapshot());
      return { inserted: result.inserted, watermark: result.watermark, events: events.length };
    });
    return run();
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private ensureInit(): void {
    if (!this.initialized) this.init();
  }

  private assertMode(mode: "replay" | "live"): void {
    if (this.mode !== "idle") {
      throw new Error(
        `@eqlcc/orchestrator: this pipeline is already in '${this.mode}' mode; ` +
          `construct a new IngestPipeline for a '${mode}' run.`,
      );
    }
    this.mode = mode;
  }
}
