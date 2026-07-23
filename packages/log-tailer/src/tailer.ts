/**
 * Resumable, byte-offset-driven single-file tailer (ARCHITECTURE.md §5).
 *
 * Design contract (see also this package's README):
 *
 * - **Offset-driven and idempotent.** The tailer is told where to start
 *   (`start(fromOffset)`) and reports the byte offset of every line it emits.
 *   Re-tailing the same bytes from the same offset yields byte-identical
 *   output. The tailer **never persists offsets itself** — committing the
 *   watermark atomically with parsed events is the database layer's job
 *   (DATA_MODEL.md `log_files.byte_offset`).
 * - **Complete lines only.** A line is emitted only once its `\n` arrives
 *   (`\r\n` tolerated; the `\r` is stripped from the emitted text). Trailing
 *   bytes without a terminator stay buffered, and the reported watermark
 *   only ever advances past fully-emitted lines, so a crash never splits a
 *   line.
 * - **Truncation / rotation.** If the file's current length is smaller than
 *   our read position, the file was truncated or replaced: emit `truncated`
 *   and restart from offset 0 (the eql-meter rule; the only safe
 *   interpretation without inode tracking).
 * - **Hybrid scheduling.** A poll loop (default every 200 ms) stats the file
 *   and is the *source of truth*; `fs.watch` is subscribed purely as a
 *   fast-path trigger because OS file events are unreliable for game logs
 *   (missed/coalesced notifications). Reads are offset-driven, so a spurious
 *   or duplicate wake-up is harmless.
 * - **Transient errors** (locked file, mid-rotation `ENOENT`, ...) are
 *   swallowed and retried on the next tick; tailing never aborts on its own.
 *
 * Known limitation (documented, deferred per ARCHITECTURE.md §5.2): if a file
 * is truncated **and regrows past the watermark within a single poll window**,
 * the length heuristic cannot see it — the observed length never drops below
 * the read position, so the replaced prefix is neither re-read nor flagged.
 * Detecting this requires inode/file-id or creation-time tracking, which the
 * architecture explicitly defers as a future refinement.
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { decodeLine, type LogEncoding } from "./encoding.js";

/** One complete, decoded log line. */
export interface TailedLine {
  /** Line text with the terminator (`\n` or `\r\n`) stripped. */
  line: string;
  /** Byte offset of the line's **first byte** in the file. */
  byteOffset: number;
  /** 1-based line number, counted from the line at the tail's start offset. */
  lineNo: number;
  /**
   * Present (and `true`) on **every fragment of an overflowed physical
   * line**: the flushed oversized buffers themselves *and* the terminal
   * newline-terminated remainder of that same physical line. These are
   * memory-safety flushes, not parseable log lines — their text starts or
   * ends mid-line — so downstream MUST route `overflow` fragments to
   * `RawUnknown` and never feed them to recognizers. Offsets stay
   * byte-true. The flag clears with the first line that *starts* after the
   * overflowed line's terminator.
   */
  overflow?: true;
}

/** A batch of complete lines plus the resume watermark they establish. */
export interface LineBatch {
  /** Complete lines, in file order. Never empty. */
  lines: TailedLine[];
  /**
   * Byte offset of the first byte **after** the last line's terminator —
   * i.e. the offset a database layer should persist (atomically with the
   * events parsed from these lines) and later pass back to
   * {@link LogTailer.start} to resume without gaps or duplicates. Buffered
   * partial-line bytes are intentionally *not* included.
   */
  watermark: number;
}

/** Payload of the `truncated` event. */
export interface TruncationEvent {
  /** Absolute path of the file that shrank. */
  path: string;
  /** The watermark before the reset (offset after the last emitted line). */
  previousWatermark: number;
  /** The file length observed when truncation was detected. */
  newLength: number;
}

export interface LogTailerOptions {
  /**
   * Poll interval in milliseconds. The poll is the source of truth;
   * `fs.watch` only accelerates it. Default 200 (ARCHITECTURE.md §5
   * recommends 150–250 for production; tests use smaller values).
   */
  pollIntervalMs?: number;
  /** Subscribe to `fs.watch` as a fast-path trigger. Default `true`. */
  useFsWatch?: boolean;
  /** Maximum bytes per read; each full chunk is emitted as one batch. Default 64 KiB. */
  maxChunkBytes?: number;
  /**
   * Cap on the buffered partial (unterminated) line. When the buffer would
   * exceed this, it is flushed as an `overflow` line (see
   * {@link TailedLine.overflow}) and the watermark advances, so a
   * never-terminated line cannot grow memory forever. A flush can carry up
   * to `maxLineBytes + maxChunkBytes` bytes. Default 1 MiB.
   */
  maxLineBytes?: number;
  /** Line decoding. Offsets always count raw bytes. Default `"windows-1252"`. */
  encoding?: LogEncoding;
}

interface TailerEvents {
  /** Batch of newly completed lines. */
  lines: [batch: LineBatch];
  /** File shrank below the read position; tail restarted from offset 0. */
  truncated: [info: TruncationEvent];
  /** Unexpected (non-transient) file I/O error. Informational: tailing continues. */
  error: [error: Error];
  /**
   * A *consumer* (event listener) threw while handling `lines` (batch
   * attached) or `truncated` (batch is `null`). Deliberately distinct from
   * `error`, which is reserved for file I/O. For a rejected `lines` batch
   * the tailer has already rewound to the batch start (see class doc), so
   * the same bytes replay on the next poll.
   */
  "consumer-error": [error: Error, batch: LineBatch | null];
}

/** Error codes treated as transient: swallow and retry on the next tick. */
const TRANSIENT_CODES = new Set([
  "EBUSY",
  "EACCES",
  "EPERM",
  "EAGAIN",
  "ENOENT",
  "EMFILE",
  "ENFILE",
  "EINTR",
]);

const EMPTY = Buffer.alloc(0);

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Validate a numeric option: must be a positive finite safe integer. */
export function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}

/**
 * Tails one log file by byte offset. See module doc for the contract.
 *
 * Lifecycle: construct → `start(fromOffset)` → `lines`/`truncated` events →
 * `stop()`. `stop()` releases every timer and watcher; a stopped tailer may
 * be `start()`ed again.
 *
 * Consumer-failure contract (watermark safety invariant): if a `lines`
 * listener throws, the batch is treated as **not consumed** — in-memory
 * state (read offset, partial buffer, line numbers) is rewound to the batch
 * start, a `consumer-error` event is emitted, the current pass aborts, and
 * the next poll re-reads and replays the identical batch. The watermark
 * therefore never advances past a batch the consumer failed to accept, so a
 * crashing downstream can never cause skipped bytes. Consumer exceptions are
 * never conflated with file I/O errors (`error`). A persistently throwing
 * listener means the same batch is retried once per poll interval until it
 * is accepted or the listener is fixed/detached.
 */
export class LogTailer extends EventEmitter<TailerEvents> {
  readonly path: string;

  private readonly pollIntervalMs: number;
  private readonly useFsWatch: boolean;
  private readonly maxChunkBytes: number;
  private readonly maxLineBytes: number;
  private readonly encoding: LogEncoding;

  private running = false;
  /**
   * Generation token: incremented by every `start()` and `stop()`. Async
   * continuations capture the generation they were born under and abandon
   * silently when it goes stale, so an in-flight read pass from a previous
   * run can never touch state (or emit) after `stop()` / a restart.
   */
  private generation = 0;
  private timer: NodeJS.Timeout | undefined;
  private watcher: fs.FSWatcher | undefined;
  private passInFlight = false;
  private wakeAfterPass = false;

  /** File offset of the next byte to read (watermark + buffered partial bytes). */
  private nextReadOffset = 0;
  /** Buffered bytes of the current incomplete trailing line. */
  private partial: Buffer = EMPTY;
  /** File offset of `partial[0]`; equals the resume watermark. */
  private partialStart = 0;
  private nextLineNo = 1;
  /**
   * True while inside an overflowed physical line: earlier bytes of the
   * current line were already flushed past the `maxLineBytes` cap, so every
   * further fragment — including the terminal remainder once its newline
   * arrives — must carry `overflow: true` (see {@link TailedLine.overflow}).
   */
  private inOverflow = false;

  constructor(filePath: string, options: LogTailerOptions = {}) {
    super();
    this.path = path.resolve(filePath);
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
    this.useFsWatch = options.useFsWatch ?? true;
    this.maxChunkBytes = options.maxChunkBytes ?? 64 * 1024;
    this.maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
    this.encoding = options.encoding ?? "windows-1252";
    requirePositiveInteger("pollIntervalMs", this.pollIntervalMs);
    requirePositiveInteger("maxChunkBytes", this.maxChunkBytes);
    requirePositiveInteger("maxLineBytes", this.maxLineBytes);
  }

  /**
   * Begin tailing at `fromOffset` (a previously reported watermark; 0 for a
   * full historical read). `firstLineNo` seeds line numbering when the
   * caller knows how many lines precede the offset.
   */
  start(fromOffset = 0, firstLineNo = 1): void {
    if (this.running) throw new Error(`LogTailer for ${this.path} is already running`);
    if (!Number.isSafeInteger(fromOffset) || fromOffset < 0) {
      throw new RangeError(`fromOffset must be a non-negative integer, got ${fromOffset}`);
    }
    this.running = true;
    this.generation++; // invalidate any in-flight pass from a previous run
    this.passInFlight = false;
    this.wakeAfterPass = false;
    this.nextReadOffset = fromOffset;
    this.partial = EMPTY;
    this.partialStart = fromOffset;
    this.nextLineNo = firstLineNo;
    this.inOverflow = false;
    if (this.useFsWatch) this.attachWatcher();
    this.schedule(0); // first pass immediately
  }

  /** Stop tailing and release all handles/timers. Idempotent. */
  stop(): void {
    this.running = false;
    this.generation++; // abandon any in-flight pass
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.detachWatcher();
  }

  /** Whether the tailer is currently running. */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Current resume watermark: offset after the last fully-emitted line.
   * Equals the `watermark` of the most recent `lines` batch (or the start
   * offset if none yet). Persisting this value is the caller's job.
   */
  get watermark(): number {
    return this.partialStart;
  }

  // ── Scheduling ──────────────────────────────────────────────────────────────

  private attachWatcher(): void {
    try {
      this.watcher = fs.watch(this.path, () => this.schedule(0));
      this.watcher.on("error", () => this.detachWatcher()); // poll still covers us
      this.watcher.unref();
    } catch {
      // fs.watch unavailable (or file not created yet) — the poll is the
      // source of truth, so tailing works regardless. pollOnce() lazily
      // re-attaches once the file is stat-able again.
      this.watcher = undefined;
    }
  }

  private detachWatcher(): void {
    if (this.watcher !== undefined) {
      try {
        this.watcher.close();
      } catch {
        // already dead — nothing to release
      }
      this.watcher = undefined;
    }
  }

  /** (Re)arm the poll timer to fire in `delayMs`. Collapses duplicate wake-ups. */
  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runPass();
    }, delayMs);
    this.timer.unref();
  }

  private async runPass(): Promise<void> {
    const gen = this.generation;
    if (!this.running) return;
    if (this.passInFlight) {
      // A watch event fired mid-pass; run one more pass right after.
      this.wakeAfterPass = true;
      return;
    }
    this.passInFlight = true;
    try {
      await this.pollOnce(gen);
    } finally {
      // If start()/stop() superseded this pass, the new generation owns the
      // flags and the schedule — a stale pass must not touch either.
      if (this.generation === gen) {
        this.passInFlight = false;
        const immediate = this.wakeAfterPass;
        this.wakeAfterPass = false;
        this.schedule(immediate ? 0 : this.pollIntervalMs);
      }
    }
  }

  // ── One poll pass: stat → truncation check → read to (stat-time) EOF ────────
  //
  // `gen` is the generation this pass was born under; after every await we
  // re-check it and abandon silently if a start()/stop() happened meanwhile —
  // otherwise a stale continuation would apply reads taken at old offsets to
  // the restarted tail's state and corrupt emitted offsets/watermarks.

  private async pollOnce(gen: number): Promise<void> {
    let size: number;
    try {
      size = (await fsp.stat(this.path)).size;
    } catch (err) {
      this.reportError(err, gen);
      return;
    }
    if (this.generation !== gen) return;

    // The file is stat-able: lazily (re-)attach the fast-path watcher if it
    // failed at start() or died since (fs.watch handles do not resurrect).
    if (this.useFsWatch && this.watcher === undefined) this.attachWatcher();

    // Truncation / rotation rule (ARCHITECTURE.md §5.2): length < our read
    // position ⇒ the file was truncated or replaced. Reset to 0 and re-read.
    // (Length-only heuristic: a truncate-and-regrow-past-the-watermark within
    // one poll window is undetectable — see module doc / README limitations.)
    if (size < this.nextReadOffset) {
      const previousWatermark = this.partialStart;
      this.nextReadOffset = 0;
      this.partial = EMPTY;
      this.partialStart = 0;
      this.nextLineNo = 1;
      this.inOverflow = false;
      // A throwing 'truncated' listener must not masquerade as an I/O error
      // (runPass has no catch — it would become an unhandled rejection). The
      // reset above is already applied and is watermark-safe (offset 0), so
      // we surface the consumer failure and carry on.
      try {
        this.emit("truncated", { path: this.path, previousWatermark, newLength: size });
      } catch (err) {
        this.emitConsumerError(err, null);
      }
    }
    if (size <= this.nextReadOffset) return; // nothing new

    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(this.path, "r");
    } catch (err) {
      this.reportError(err, gen);
      return;
    }
    try {
      // Read only up to the stat-time size: keeps a pass bounded even while
      // the game keeps appending (the next tick picks up the rest).
      while (this.generation === gen && this.nextReadOffset < size) {
        const want = Math.min(this.maxChunkBytes, size - this.nextReadOffset);
        const buf = Buffer.allocUnsafe(want);
        const { bytesRead } = await handle.read(buf, 0, want, this.nextReadOffset);
        if (this.generation !== gen) return; // superseded mid-read: abandon
        if (bytesRead <= 0) break; // shrank mid-read; next pass re-checks
        // A consumer rejected the batch: state is rewound, abort the pass —
        // the next poll re-reads the same bytes and replays the batch.
        if (!this.ingest(buf.subarray(0, bytesRead))) return;
      }
    } catch (err) {
      this.reportError(err, gen);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /**
   * Split a newly-read chunk into complete lines; buffer the remainder.
   * Only called from a pass whose generation is current (and `ingest` is
   * synchronous), so it may mutate state and emit freely.
   *
   * Returns `false` when a `lines` listener threw. In that case nothing
   * from this chunk counts as consumed: all in-memory state is rewound to
   * the batch start, `consumer-error` is emitted with the rejected batch,
   * and the caller must abort the pass so the next poll replays the same
   * bytes (see the class doc's consumer-failure contract).
   */
  private ingest(chunk: Buffer): boolean {
    // Snapshot for rewind in case the consumer rejects the batch.
    const prevNextReadOffset = this.nextReadOffset;
    const prevPartial = this.partial;
    const prevPartialStart = this.partialStart;
    const prevLineNo = this.nextLineNo;
    const prevInOverflow = this.inOverflow;

    const base = this.partialStart;
    const buf = this.partial.length > 0 ? Buffer.concat([this.partial, chunk]) : chunk;
    this.nextReadOffset += chunk.length;

    const lines: TailedLine[] = [];
    // True while the bytes being scanned belong to a physical line whose
    // earlier bytes were already flushed as overflow fragments.
    let carryOverflow = this.inOverflow;
    let lineStart = 0;
    let nl: number;
    while ((nl = buf.indexOf(0x0a, lineStart)) !== -1) {
      let end = nl;
      if (end > lineStart && buf[end - 1] === 0x0d) end--; // tolerate CRLF
      const line: TailedLine = {
        line: decodeLine(buf.subarray(lineStart, end), this.encoding),
        byteOffset: base + lineStart,
        lineNo: this.nextLineNo++,
      };
      if (carryOverflow) {
        // This newline terminates an overflowed physical line: its terminal
        // remainder is a fragment too, never a parseable line.
        line.overflow = true;
        carryOverflow = false;
      }
      lines.push(line);
      lineStart = nl + 1;
    }

    // Memory-safety valve: a never-terminated line must not buffer forever.
    // Flush the oversized remainder as an `overflow` fragment and advance
    // the watermark past it (see TailedLine.overflow for the semantics).
    if (buf.length - lineStart > this.maxLineBytes) {
      lines.push({
        line: decodeLine(buf.subarray(lineStart), this.encoding),
        byteOffset: base + lineStart,
        lineNo: this.nextLineNo++,
        overflow: true,
      });
      lineStart = buf.length;
      carryOverflow = true; // the rest of this physical line is fragments too
    }
    this.inOverflow = carryOverflow;

    // Copy the remainder so we never pin the (up to 64 KiB) read buffer.
    this.partial = lineStart < buf.length ? Buffer.from(buf.subarray(lineStart)) : EMPTY;
    this.partialStart = base + lineStart;

    if (lines.length > 0) {
      const batch: LineBatch = { lines, watermark: this.partialStart };
      try {
        this.emit("lines", batch);
      } catch (err) {
        // Watermark safety invariant: a batch the consumer failed to accept
        // is not consumed. Rewind so no later batch can carry a watermark
        // past it, and report the failure distinctly from file I/O errors.
        this.nextReadOffset = prevNextReadOffset;
        this.partial = prevPartial;
        this.partialStart = prevPartialStart;
        this.nextLineNo = prevLineNo;
        this.inOverflow = prevInOverflow;
        this.emitConsumerError(err, batch);
        return false;
      }
    }
    return true;
  }

  /** Surface a consumer (listener) exception; never let it escape the pass. */
  private emitConsumerError(err: unknown, batch: LineBatch | null): void {
    try {
      this.emit("consumer-error", asError(err), batch);
    } catch {
      // A throwing consumer-error listener is dropped — there is no further
      // channel to report it on, and it must not corrupt the pass.
    }
  }

  /**
   * Transient errors (file locked, mid-rotation ENOENT, ...) are silently
   * retried next tick. Anything else is also retried — tailing never aborts
   * itself — but is surfaced via `error` when someone is listening (and the
   * reporting pass is still current).
   */
  private reportError(err: unknown, gen: number): void {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code !== undefined && TRANSIENT_CODES.has(code)) return;
    if (this.generation === gen && this.listenerCount("error") > 0) {
      try {
        this.emit("error", asError(err));
      } catch (listenerErr) {
        // Even the I/O-error channel gets consumer-failure isolation: a
        // throwing 'error' listener must not become an unhandled rejection.
        this.emitConsumerError(listenerErr, null);
      }
    }
  }
}
