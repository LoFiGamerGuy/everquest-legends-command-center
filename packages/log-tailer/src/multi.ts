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
import {
  LogTailer,
  requirePositiveInteger,
  type LineBatch,
  type LogTailerOptions,
  type TruncationEvent,
} from "./tailer.js";

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
   * Tail only the N most recently modified log files. Must be a positive
   * integer; `Infinity` is explicitly allowed and, like omitting the
   * option, means "tail every discovered file".
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
  /** File I/O error from one file's tailer. */
  error: [error: Error, fileId: string];
  /**
   * A consumer (listener) threw while handling this file's `lines` (batch
   * attached) or `truncated` (batch is `null`). The underlying tailer has
   * already rewound, so a rejected batch replays on its next poll — see
   * LogTailer's consumer-failure contract.
   */
  "consumer-error": [error: Error, fileId: string, batch: ManagedLineBatch | null];
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
    if (options.maxFiles !== undefined && options.maxFiles !== Infinity) {
      requirePositiveInteger("maxFiles", options.maxFiles);
    }
    this.options = options;
  }

  /**
   * Discover files and start one tailer per selected file. Transactional:
   * if discovery or any tailer startup throws (bad Logs directory, throwing
   * `resolveStartOffset`, ...), every tailer already started by this call is
   * stopped, the manager is left not-running, and the error propagates.
   */
  start(): void {
    if (this.running) throw new Error("TailManager is already running");
    this.running = true;
    try {
      this.rescan(); // rolls back its own additions on failure
    } catch (err) {
      this.stop(); // release anything that survived (defensive; also resets running)
      throw err;
    }
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
   *
   * Failure semantics: if adding any newly selected file throws (bad
   * directory read happens before any change; a throwing
   * `resolveStartOffset` or tailer startup mid-scan), the additions made by
   * *this* scan are stopped and removed again, then the error propagates.
   * Tails that were already live before the scan stay live; removals
   * (stopped tailers) are not resurrected.
   */
  rescan(): { added: DiscoveredLogFile[]; removed: DiscoveredLogFile[] } {
    if (!this.running) throw new Error("TailManager is not running");
    const discovered = discoverLogFiles(this.options.logsDir); // most recent first
    const maxFiles = this.options.maxFiles ?? Infinity;
    const desired = maxFiles === Infinity ? discovered : discovered.slice(0, maxFiles);
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
    try {
      for (const file of desired) {
        const existing = this.tails.get(file.path);
        if (existing !== undefined) {
          existing.file = file; // refresh size/mtime metadata; tailer stays live
        } else {
          this.addTail(file);
          added.push(file);
        }
      }
    } catch (err) {
      // Roll back this scan's additions so a failed scan leaves no strays.
      for (const file of added) {
        this.tails.get(file.path)?.tailer.stop();
        this.tails.delete(file.path);
      }
      throw err;
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

  /**
   * Transactional insert: anything that can throw — `resolveStartOffset`,
   * tailer construction (option validation), `tailer.start` (offset
   * validation) — happens before the entry is registered in `tails`, so a
   * failed add leaves no partially-started tailer behind.
   */
  private addTail(file: DiscoveredLogFile): void {
    const fileId = file.path;
    const fromOffset = this.options.resolveStartOffset?.(file) ?? 0; // may throw
    const tailer = new LogTailer(file.path, this.options.tailer ?? {}); // may throw
    const entry = { file, tailer };
    // Read `entry.file` at emit time so rescan metadata refreshes are seen.
    tailer.on("lines", (batch) => this.emit("lines", { ...batch, fileId, file: entry.file }));
    tailer.on("truncated", (info) => this.emit("truncated", { ...info, fileId, file: entry.file }));
    tailer.on("error", (err) => {
      if (this.listenerCount("error") > 0) this.emit("error", err, fileId);
    });
    tailer.on("consumer-error", (err, batch) => {
      this.emit(
        "consumer-error",
        err,
        fileId,
        batch === null ? null : { ...batch, fileId, file: entry.file },
      );
    });
    try {
      tailer.start(fromOffset); // may throw (validates fromOffset)
    } catch (err) {
      tailer.stop(); // defensive: release anything start() managed to arm
      throw err;
    }
    this.tails.set(fileId, entry); // registered only once fully started
  }
}
