/**
 * SessionService — the thin, typed M2 seam (docs/SESSION_SERVICE_SPEC.md).
 *
 * Composes the durable ingest pipeline (`@eqlcc/orchestrator`), the projection
 * driver (`@eqlcc/analytics`), and the read API into UI-ready view-models. It is
 * a CALLER-DRIVEN PULL seam: `start()` ingests the existing file and (for live)
 * begins tailing; `refresh()` catches projections up to the ingested head and
 * recomputes the view. No internal timers, no `Date.now()` — the caller (the
 * Tauri app's interval, or a test) drives the cadence, keeping the service
 * deterministic and free of hidden clocks.
 *
 * `IngestPipeline` is single-mode (replay OR live per instance), so a live
 * session uses a replay pipeline to ingest the existing file, then a FRESH live
 * pipeline that resumes from the persisted watermark to tail — the durable-resume
 * pattern the golden e2e proves.
 */

import type { SqlDatabase, LogFileInput } from "@eqlcc/database";
import { IngestPipeline } from "@eqlcc/orchestrator";
import {
  finalizeEncounters,
  updateProjections,
  type ProjectionOptionsInput,
} from "@eqlcc/analytics";

import { deriveLiveView, type LiveView, type ServiceStatus } from "./view.js";

/**
 * The character log to track — structural primitives only, so the public options
 * surface carries no `@eqlcc/database`/`@eqlcc/orchestrator` type (the service
 * builds the internal `LogFileInput` from these).
 */
export interface SessionLogSource {
  /** Absolute path to the character log file. */
  path: string;
  /** Dialect id (e.g. the beta-dialect constant from `@eqlcc/event-schema`). */
  dialectId: string;
  /** Character (owner) name — enables "You" attribution. */
  characterName?: string;
  /** Server namespace. */
  server?: string;
}

/** The single live-tailer knob the seam forwards, kept local (no orchestrator type). */
export interface SessionTailerOptions {
  /** Poll interval in ms (default 200). */
  pollIntervalMs?: number;
}

export interface SessionServiceOptions {
  /**
   * A migrated database handle. This is the BACKEND construction seam: the service
   * runs on the Node side of the desktop app and owns the data layer. The UI never
   * constructs the service — it consumes {@link LiveView} over IPC (spec §0/§4), so
   * this data-layer handle never crosses the UI boundary.
   */
  db: SqlDatabase;
  /** The character log to track. */
  logFile: SessionLogSource;
  /**
   * Tail the file for live updates after the initial replay. When false (default),
   * `start()` is a one-shot static load of a complete log and terminal-closes all
   * encounters; when true, tailing begins and the last encounter stays active.
   */
  live?: boolean;
  /** Projection tuning forwarded to the analytics driver (encounter timeouts, …). */
  projection?: ProjectionOptionsInput;
  /** Live-tailer options. */
  tailer?: SessionTailerOptions;
  /** Max closed encounters kept in `recentEncounters` (default 10). */
  recentLimit?: number;
  /**
   * Notified of a live tailing halt (truncation/rotation) or a batch-commit
   * failure. The service also records it as `lastError` and reports
   * `status: "error"`; provided for callers that want to react immediately.
   */
  onError?: (error: Error) => void;
}

type Subscriber = (view: LiveView) => void;

export class SessionService {
  private readonly db: SqlDatabase;
  private readonly options: SessionServiceOptions;
  private readonly recentLimit: number;

  private logFileId = -1;
  private started = false;
  private live: IngestPipeline | undefined;
  private statusValue: ServiceStatus = "idle";
  private errorValue: Error | null = null;
  private lastSeq = -1;
  private readonly subscribers = new Set<Subscriber>();

  constructor(options: SessionServiceOptions) {
    this.db = options.db;
    this.options = options;
    this.recentLimit = options.recentLimit ?? 10;
    if (!Number.isSafeInteger(this.recentLimit) || this.recentLimit < 0) {
      throw new RangeError(`recentLimit must be a non-negative integer, got ${this.recentLimit}`);
    }
  }

  /** Current derived status (see spec §3). */
  get status(): ServiceStatus {
    return this.errorValue !== null ? "error" : this.statusValue;
  }

  /**
   * Ingest the existing file to its head, catch projections up, then either begin
   * live tailing (`live`) or terminal-close encounters (static). Returns the first
   * {@link LiveView}. Throws only on a replay/ingest failure of the existing file;
   * live failures after this surface via `status`/`lastError`, never by throwing.
   */
  start(): LiveView {
    if (this.started) throw new Error("@eqlcc/session-service: start() called twice");
    this.started = true;
    this.statusValue = "replaying";
    const logFileInput = this.buildLogFileInput();
    // Pass 1: replay the existing file (its own single-use pipeline).
    const replay = new IngestPipeline({
      db: this.db,
      logFile: logFileInput,
      ...(this.options.tailer !== undefined ? { tailer: this.options.tailer } : {}),
    });
    replay.replay();
    this.logFileId = replay.logFileId;

    // Derive everything ingested so far.
    updateProjections(this.db, this.options.projection ?? {});

    if (this.options.live === true) {
      // Pass 2: a fresh pipeline resumes from the persisted watermark and tails.
      // `onError` is the FATAL channel per spec §3 (halt/commit failure); the
      // orchestrator's informational tailer-I/O `onError` is intentionally not
      // forwarded here — tailing continues through those on its own.
      const live = new IngestPipeline({
        db: this.db,
        logFile: logFileInput,
        ...(this.options.tailer !== undefined ? { tailer: this.options.tailer } : {}),
        onConsumerError: (e) => this.onLiveFailure(e),
        onTruncation: (info) =>
          this.onLiveFailure(
            new Error(
              `@eqlcc/session-service: live tailing halted — log truncated/rotated ` +
                `(shrank to ${info.newLength} bytes below watermark ${info.previousWatermark}).`,
            ),
          ),
      });
      this.live = live;
      // A synchronous startLive failure (e.g. the file vanished between replay and
      // tail) is a live failure, not a replay failure — route it, don't throw.
      try {
        live.startLive();
        this.statusValue = "live";
      } catch (e) {
        this.onLiveFailure(e instanceof Error ? e : new Error(String(e)));
      }
    } else {
      // Static load of a complete log: close every encounter so nothing shows active.
      finalizeEncounters(this.db, undefined, this.options.projection ?? {});
      this.statusValue = "stopped";
    }

    const view = this.computeView();
    this.lastSeq = view.watermark.seq;
    return view;
  }

  /**
   * Live heartbeat: catch projections up to the ingested head, recompute the view,
   * and notify subscribers IFF the watermark advanced. Idempotent when no new bytes
   * have been tailed. Never throws — a recorded live error is reflected in the view.
   */
  refresh(): LiveView {
    if (this.logFileId < 0) {
      throw new Error("@eqlcc/session-service: refresh() called before start()");
    }
    updateProjections(this.db, this.options.projection ?? {});
    const view = this.computeView();
    if (view.watermark.seq !== this.lastSeq) {
      this.lastSeq = view.watermark.seq;
      for (const cb of this.subscribers) cb(view);
    }
    return view;
  }

  /** Recompute the view from current projection state without catching up (spec §2). */
  getLiveView(): LiveView {
    if (this.logFileId < 0) {
      throw new Error("@eqlcc/session-service: getLiveView() called before start()");
    }
    return this.computeView();
  }

  /** Subscribe to post-`refresh` updates; returns an unsubscribe function. */
  onUpdate(cb: Subscriber): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  /** Stop live tailing and release handles. Idempotent; the last view stays readable. */
  stop(): void {
    if (this.live !== undefined) {
      this.live.stop();
      this.live = undefined;
    }
    if (this.errorValue === null) this.statusValue = "stopped";
  }

  /** Build the internal `LogFileInput` from the public structural log source. */
  private buildLogFileInput(): LogFileInput {
    const src = this.options.logFile;
    return {
      path: src.path,
      dialectId: src.dialectId,
      ...(src.characterName !== undefined ? { characterName: src.characterName } : {}),
      ...(src.server !== undefined ? { server: src.server } : {}),
    };
  }

  private computeView(): LiveView {
    return deriveLiveView(
      this.db,
      this.logFileId,
      this.status,
      this.errorValue === null ? null : this.errorValue.message,
      this.recentLimit,
    );
  }

  private onLiveFailure(error: Error): void {
    this.errorValue = error;
    // The pipeline stops itself before invoking these callbacks; drop our handle.
    this.live = undefined;
    this.options.onError?.(error);
  }
}
