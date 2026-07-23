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
 * fresh as the watermark and survives a restart without re-reading the file.
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
import type { LogEvent, RawUnknownEvent } from "@eqlcc/event-schema";
import {
  EntityResolver,
  LineSplitter,
  LogParser,
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

import { loadResolverSnapshot, pipelineMigrations, saveResolverSnapshot } from "./resolver-store.js";

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
  /** Notified when the tailer detects truncation/rotation in live mode (deferred handling; see class doc). */
  onTruncation?: (info: TruncationEvent) => void;
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
    // Base schema + resolver_snapshot, forward-only, transactional, idempotent.
    migrate(db, { migrations: pipelineMigrations() });

    const logFileId = upsertLogFile(db, this.options.logFile);
    const watermark = getWatermark(db, logFileId);

    const parser = new LogParser({
      logFileId,
      startSeq: watermark.seq,
      ...(this.options.registry === undefined ? {} : { registry: this.options.registry }),
    });

    const snapshot = loadResolverSnapshot(db, logFileId);
    const resolver =
      snapshot === undefined
        ? EntityResolver.forLogFile(path.basename(this.options.logFile.path), logFileId)
        : EntityResolver.fromSnapshot(snapshot);

    this.dbHandle = db;
    this.logFileIdValue = logFileId;
    this.startOffset = watermark.byteOffset;
    this.startSeq = watermark.seq;
    this.parser = parser;
    this.resolverInstance = resolver;
    this.initialized = true;
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

    let splitter = new LineSplitter(this.startOffset, this.startSeq + 1);
    let batches = 0;
    let linesProcessed = 0;
    let inserted = 0;

    const fd = fs.openSync(this.options.logFile.path, "r");
    try {
      const size = fs.fstatSync(fd).size;
      // Truncation/rotation guard (ARCHITECTURE.md §5.2): a file shorter than our
      // resume offset was truncated or replaced. Re-read from 0 (the tailer's rule).
      let pos = this.startOffset;
      if (size < pos) {
        pos = 0;
        this.resetForOffsetZero();
        splitter = new LineSplitter(0, 1);
      }

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
      // Deferred (see class doc / report): truncation mid-live needs a DB
      // watermark + parser/resolver reset that edges into #20 rotation semantics.
      // Surface it so a caller can react; do not silently re-ingest against the
      // old watermark (ingestEvents would reject a changed line at a live offset).
      this.options.onTruncation?.(info);
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

  /** Reset parser seq + resolver to a fresh offset-0 state (truncation/rotation). */
  private resetForOffsetZero(): void {
    this.startOffset = 0;
    this.startSeq = 0;
    this.parser = new LogParser({
      logFileId: this.logFileIdValue,
      startSeq: 0,
      ...(this.options.registry === undefined ? {} : { registry: this.options.registry }),
    });
    this.resolverInstance = EntityResolver.forLogFile(
      path.basename(this.options.logFile.path),
      this.logFileIdValue,
    );
  }
}
