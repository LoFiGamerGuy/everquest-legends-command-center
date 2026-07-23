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
  /** Line decoding. Offsets always count raw bytes. Default `"windows-1252"`. */
  encoding?: LogEncoding;
}

interface TailerEvents {
  /** Batch of newly completed lines. */
  lines: [batch: LineBatch];
  /** File shrank below the read position; tail restarted from offset 0. */
  truncated: [info: TruncationEvent];
  /** Unexpected (non-transient) error. Informational: tailing continues. */
  error: [error: Error];
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

/**
 * Tails one log file by byte offset. See module doc for the contract.
 *
 * Lifecycle: construct → `start(fromOffset)` → `lines`/`truncated` events →
 * `stop()`. `stop()` releases every timer and watcher; a stopped tailer may
 * be `start()`ed again.
 */
export class LogTailer extends EventEmitter<TailerEvents> {
  readonly path: string;

  private readonly pollIntervalMs: number;
  private readonly useFsWatch: boolean;
  private readonly maxChunkBytes: number;
  private readonly encoding: LogEncoding;

  private running = false;
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

  constructor(filePath: string, options: LogTailerOptions = {}) {
    super();
    this.path = path.resolve(filePath);
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
    this.useFsWatch = options.useFsWatch ?? true;
    this.maxChunkBytes = options.maxChunkBytes ?? 64 * 1024;
    this.encoding = options.encoding ?? "windows-1252";
    if (this.pollIntervalMs <= 0) throw new RangeError("pollIntervalMs must be > 0");
    if (this.maxChunkBytes <= 0) throw new RangeError("maxChunkBytes must be > 0");
  }

  /**
   * Begin tailing at `fromOffset` (a previously reported watermark; 0 for a
   * full historical read). `firstLineNo` seeds line numbering when the
   * caller knows how many lines precede the offset.
   */
  start(fromOffset = 0, firstLineNo = 1): void {
    if (this.running) throw new Error(`LogTailer for ${this.path} is already running`);
    if (!Number.isInteger(fromOffset) || fromOffset < 0) {
      throw new RangeError(`fromOffset must be a non-negative integer, got ${fromOffset}`);
    }
    this.running = true;
    this.nextReadOffset = fromOffset;
    this.partial = EMPTY;
    this.partialStart = fromOffset;
    this.nextLineNo = firstLineNo;
    if (this.useFsWatch) this.attachWatcher();
    this.schedule(0); // first pass immediately
  }

  /** Stop tailing and release all handles/timers. Idempotent. */
  stop(): void {
    this.running = false;
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
      // source of truth, so tailing works regardless.
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
    if (!this.running) return;
    if (this.passInFlight) {
      // A watch event fired mid-pass; run one more pass right after.
      this.wakeAfterPass = true;
      return;
    }
    this.passInFlight = true;
    try {
      await this.pollOnce();
    } finally {
      this.passInFlight = false;
      const immediate = this.wakeAfterPass;
      this.wakeAfterPass = false;
      this.schedule(immediate ? 0 : this.pollIntervalMs);
    }
  }

  // ── One poll pass: stat → truncation check → read to (stat-time) EOF ────────

  private async pollOnce(): Promise<void> {
    let size: number;
    try {
      size = (await fsp.stat(this.path)).size;
    } catch (err) {
      this.reportError(err);
      return;
    }

    // Truncation / rotation rule (ARCHITECTURE.md §5.2): length < our read
    // position ⇒ the file was truncated or replaced. Reset to 0 and re-read.
    if (size < this.nextReadOffset) {
      const previousWatermark = this.partialStart;
      this.nextReadOffset = 0;
      this.partial = EMPTY;
      this.partialStart = 0;
      this.nextLineNo = 1;
      if (this.running) this.emit("truncated", { path: this.path, previousWatermark, newLength: size });
    }
    if (size <= this.nextReadOffset) return; // nothing new

    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(this.path, "r");
    } catch (err) {
      this.reportError(err);
      return;
    }
    try {
      // Read only up to the stat-time size: keeps a pass bounded even while
      // the game keeps appending (the next tick picks up the rest).
      while (this.running && this.nextReadOffset < size) {
        const want = Math.min(this.maxChunkBytes, size - this.nextReadOffset);
        const buf = Buffer.allocUnsafe(want);
        const { bytesRead } = await handle.read(buf, 0, want, this.nextReadOffset);
        if (bytesRead <= 0) break; // shrank mid-read; next pass re-checks
        this.ingest(buf.subarray(0, bytesRead));
      }
    } catch (err) {
      this.reportError(err);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /** Split a newly-read chunk into complete lines; buffer the remainder. */
  private ingest(chunk: Buffer): void {
    const base = this.partialStart;
    const buf = this.partial.length > 0 ? Buffer.concat([this.partial, chunk]) : chunk;
    this.nextReadOffset += chunk.length;

    const lines: TailedLine[] = [];
    let lineStart = 0;
    let nl: number;
    while ((nl = buf.indexOf(0x0a, lineStart)) !== -1) {
      let end = nl;
      if (end > lineStart && buf[end - 1] === 0x0d) end--; // tolerate CRLF
      lines.push({
        line: decodeLine(buf.subarray(lineStart, end), this.encoding),
        byteOffset: base + lineStart,
        lineNo: this.nextLineNo++,
      });
      lineStart = nl + 1;
    }

    // Copy the remainder so we never pin the (up to 64 KiB) read buffer.
    this.partial = lineStart < buf.length ? Buffer.from(buf.subarray(lineStart)) : EMPTY;
    this.partialStart = base + lineStart;

    if (lines.length > 0 && this.running) {
      this.emit("lines", { lines, watermark: this.partialStart });
    }
  }

  /**
   * Transient errors (file locked, mid-rotation ENOENT, ...) are silently
   * retried next tick. Anything else is also retried — tailing never aborts
   * itself — but is surfaced via `error` when someone is listening.
   */
  private reportError(err: unknown): void {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code !== undefined && TRANSIENT_CODES.has(code)) return;
    if (this.running && this.listenerCount("error") > 0) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }
}
