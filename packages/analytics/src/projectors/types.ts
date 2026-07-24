/**
 * Projector contract and per-pass context (docs/PROJECTIONS_SPEC.md §1).
 *
 * A projector is `{ name, version, tablesOwned, load, apply, finalize, reset }`.
 * The driver reads events in `(log_file_id, seq)` order and, for each event,
 * calls `apply` on every projector whose stored `version` matches and whose
 * watermark is behind that event, advancing the watermark IN THE SAME
 * TRANSACTION as the writes. `load` reconstructs a projector's in-memory working
 * state from already-written rows at the start of a pass — this is what makes
 * incremental application equal a full rebuild (§9.2): a projector never depends
 * on state that only exists within a single process's memory.
 */

import type { LogEvent } from "@eqlcc/event-schema";
import type { EntityResolver } from "@eqlcc/log-parser";

import type { ProjectionOptions } from "../options.js";
import type { EntityIndex } from "../entity-index.js";

/** A DB handle with the minimal surface the projectors use (better-sqlite3). */
export type Db = import("@eqlcc/database").SqlDatabase;

/**
 * An event enriched with the projection FK columns the driver keeps in sync
 * with the `events` row as earlier projectors assign them within a pass. On a
 * partial (single-projector) rebuild the assigning projector is skipped, so
 * these are seeded from the persisted `events` columns; downstream projectors
 * always read them from here, never re-deriving.
 */
export interface PassEvent {
  readonly event: LogEvent;
  /** `events.id` (rowid) — the watermark unit (spec §1). */
  readonly id: number;
  /** `events.session_id`, assigned by the sessions projector this pass. */
  sessionId: number | null;
  /** `events.encounter_id`, assigned by the encounters projector this pass. */
  encounterId: number | null;
}

/** Mutable state shared across projectors within one pass. */
export interface PassContext {
  readonly db: Db;
  readonly options: ProjectionOptions;
  /** The single resolver advanced alongside the projectors (spec §1). */
  readonly resolver: EntityResolver;
  /** name → entities.id, owned by the entities projector. */
  readonly entities: EntityIndex;
  /** Log file whose owner the resolver represents (M1: one file per pass). */
  readonly logFileId: number;
  /** Owner canonical id (the resolver's log owner). */
  readonly ownerId: string;
}

/**
 * A projection writer. `version` is compared with the stored
 * `projection_state.version`; a mismatch triggers {@link Projector.reset} and a
 * rebuild from `last_event_id = 0` for this projector alone (spec §9.3).
 */
export interface Projector {
  readonly name: string;
  readonly version: number;
  readonly tablesOwned: readonly string[];
  /**
   * Reconstruct in-memory working state from rows already written. `watermark`
   * is this projector's `last_event_id`; any reconstruction that reads `events`
   * must bound on `id <= watermark` (rows for not-yet-processed events are
   * already in the table).
   */
  load(ctx: PassContext, watermark: number): void;
  /** Process one event, writing this projector's rows. */
  apply(ctx: PassContext, pe: PassEvent): void;
  /** End-of-pass work (e.g. entities syncing final resolver state). Optional. */
  finalize?(ctx: PassContext): void;
  /** Wipe this projector's outputs (and null any `events` FK columns it owns). */
  reset(ctx: PassContext): void;
}
