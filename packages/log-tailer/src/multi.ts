/**
 * Multi-file tail management (ARCHITECTURE.md §5.5): run discovery over a
 * Logs directory, tail the most recently modified N files (or all of them),
 * and aggregate their events onto one emitter.
 *
 * File ids: each tailed file is identified by its **resolved absolute path**
 * (`DiscoveredLogFile.path`), which is stable across restarts and rescans —
 * the same identity `log_files.path` uses in the database (DATA_MODEL.md).
 *
 * Offsets: like {@link LogTailer}, the manager never persists watermarks.
 * The caller supplies per-file start offsets via `resolveStartOffset`
 * (typically read from `log_files.byte_offset`); files without a stored
 * watermark start at 0.
 */

import { EventEmitter } from "node:events";

import { discoverLogFiles, type DiscoveredLogFile } from "./discovery.js";
import { LogTailer, type LineBatch, type LogTailerOptions, type TruncationEvent } from "./tailer.js";

/** A {@link LineBatch} tagged with the file it came from. */
export interface ManagedLineBatch extends LineBatch {
  /** Stable per-file id: the resolved absolute path. */
  fileId: string;
  /** Discovery metadata for the file (as of the scan that selected it). */
  file: DiscoveredLogFile;
}

/** A {@link TruncationEvent} tagged with the file it came from. */
export interface ManagedTruncationEvent extends TruncationEvent {
  fileId: string;
  file: DiscoveredLogFile;
}

export interface TailManagerOptions {
  /** Logs directory to scan for `eqlog_<Character>_<server>.txt` files. */
  logsDir: string;
  /**
   * Tail only the N most recently modified log files. Omit (or set to
   * `Infinity`) to tail every discovered file.
   */
  maxFiles?: number;
  /**
   * Resume offset per file — normally the stored `log_files.byte_offset`
   * watermark. Defaults to 0 (full read) for every file.
   */
  resolveStartOffset?: (file: DiscoveredLogFile) => number;
  /** Options forwarded to each per-file {@link LogTailer}. */
  tailer?: LogTailerOptions;
}

interface ManagerEvents {
  lines: [batch: ManagedLineBatch];
  truncated: [info: ManagedTruncationEvent];
  error: [error: Error, fileId: string];
}

/**
 * Discovers log files and tails each with its own {@link LogTailer},
 * re-emitting `lines` / `truncated` / `error` tagged with a stable `fileId`.
 *
 * Lifecycle: construct → `start()` → events → `stop()`. `rescan()` picks up
 * files that appeared after `start()` (never dropping files already tailed).
 */
export class TailManager extends EventEmitter<ManagerEvents> {
  private readonly options: TailManagerOptions;
  private readonly tails = new Map<string, { file: DiscoveredLogFile; tailer: LogTailer }>();
  private running = false;

  constructor(options: TailManagerOptions) {
    super();
    if (options.maxFiles !== undefined && options.maxFiles < 1) {
      throw new RangeError("maxFiles must be >= 1");
    }
    this.options = options;
  }

  /** Discover files and start one tailer per selected file. */
  start(): void {
    if (this.running) throw new Error("TailManager is already running");
    this.running = true;
    this.rescan();
  }

  /**
   * Re-run discovery and start tailing any newly selected files. Files
   * already being tailed are kept as-is (their offsets are live). Returns
   * the files newly added by this scan.
   */
  rescan(): DiscoveredLogFile[] {
    if (!this.running) throw new Error("TailManager is not running");
    const discovered = discoverLogFiles(this.options.logsDir); // most recent first
    const limit = this.options.maxFiles ?? Infinity;
    const added: DiscoveredLogFile[] = [];
    for (const file of discovered) {
      if (this.tails.size >= limit && !this.tails.has(file.path)) continue;
      if (this.tails.has(file.path)) continue;
      this.addTail(file);
      added.push(file);
    }
    return added;
  }

  /** Stop every tailer and release all handles/timers. Idempotent. */
  stop(): void {
    this.running = false;
    for (const { tailer } of this.tails.values()) tailer.stop();
    this.tails.clear();
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Snapshot of currently tailed files, keyed by fileId (absolute path). */
  files(): ReadonlyMap<string, DiscoveredLogFile> {
    const out = new Map<string, DiscoveredLogFile>();
    for (const [id, { file }] of this.tails) out.set(id, file);
    return out;
  }

  /** Current resume watermark for one tailed file, or undefined if not tailed. */
  watermarkOf(fileId: string): number | undefined {
    return this.tails.get(fileId)?.tailer.watermark;
  }

  private addTail(file: DiscoveredLogFile): void {
    const fileId = file.path;
    const tailer = new LogTailer(file.path, this.options.tailer ?? {});
    tailer.on("lines", (batch) => this.emit("lines", { ...batch, fileId, file }));
    tailer.on("truncated", (info) => this.emit("truncated", { ...info, fileId, file }));
    tailer.on("error", (err) => {
      if (this.listenerCount("error") > 0) this.emit("error", err, fileId);
    });
    this.tails.set(fileId, { file, tailer });
    const fromOffset = this.options.resolveStartOffset?.(file) ?? 0;
    tailer.start(fromOffset);
  }
}
