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
 * Lifecycle: construct → `start()` → events → `stop()`. `rescan()`
 * reconciles the tailed set against the current mtime ranking: at `maxFiles`
 * capacity a newer file swaps out the stalest tailed one (its tailer is
 * stopped cleanly first).
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
   * Re-run discovery and reconcile the tailed set against the fresh
   * most-recently-modified ranking:
   *
   * - files newly in the top `maxFiles` start tailing (offset from
   *   `resolveStartOffset`),
   * - files that fell out of the top `maxFiles` — or vanished from the
   *   directory — have their tailer stopped cleanly and are dropped,
   * - files tailed both before and after keep their **live** tailer
   *   (offsets are never reset by a rescan) with refreshed metadata.
   *
   * A re-added file resumes wherever `resolveStartOffset` says, so pairing
   * rescans with a persisted watermark (see README) makes swaps lossless.
   */
  rescan(): { added: DiscoveredLogFile[]; removed: DiscoveredLogFile[] } {
    if (!this.running) throw new Error("TailManager is not running");
    const discovered = discoverLogFiles(this.options.logsDir); // most recent first
    const desired = discovered.slice(0, this.options.maxFiles ?? discovered.length);
    const desiredIds = new Set(desired.map((f) => f.path));

    const removed: DiscoveredLogFile[] = [];
    for (const [id, entry] of this.tails) {
      if (!desiredIds.has(id)) {
        entry.tailer.stop();
        this.tails.delete(id);
        removed.push(entry.file);
      }
    }

    const added: DiscoveredLogFile[] = [];
    for (const file of desired) {
      const existing = this.tails.get(file.path);
      if (existing !== undefined) {
        existing.file = file; // refresh size/mtime metadata; tailer stays live
      } else {
        this.addTail(file);
        added.push(file);
      }
    }
    return { added, removed };
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
    const entry = { file, tailer };
    // Read `entry.file` at emit time so rescan metadata refreshes are seen.
    tailer.on("lines", (batch) => this.emit("lines", { ...batch, fileId, file: entry.file }));
    tailer.on("truncated", (info) => this.emit("truncated", { ...info, fileId, file: entry.file }));
    tailer.on("error", (err) => {
      if (this.listenerCount("error") > 0) this.emit("error", err, fileId);
    });
    this.tails.set(fileId, entry);
    const fromOffset = this.options.resolveStartOffset?.(file) ?? 0;
    tailer.start(fromOffset);
  }
}
