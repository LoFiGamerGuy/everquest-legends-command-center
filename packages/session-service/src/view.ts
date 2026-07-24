/**
 * View-models — the UI contract (docs/SESSION_SERVICE_SPEC.md §4) — plus the
 * pure `deriveLiveView` shaper. Shaping only: every aggregate is delegated to the
 * `@eqlcc/analytics` read API; this module adds selection, ranking, and framing,
 * never new aggregation. Deterministic: a pure function of projection state
 * (`updatedTs` is the log clock, never wall-clock).
 */

import type { SqlDatabase } from "@eqlcc/database";
import { getWatermark } from "@eqlcc/database";
import {
  getActorStats,
  getSessionSummary,
  getSessions,
  listEncounters,
} from "@eqlcc/analytics";
import type {
  ActorStatsRow,
  EncounterHeader,
  Provenance,
  SessionSummary,
} from "@eqlcc/analytics";

export type ServiceStatus = "idle" | "replaying" | "live" | "stopped" | "error";

/** An active encounter shaped for the tracker: folded, ranked actors + provenance. */
export interface EncounterView {
  header: EncounterHeader;
  /** Owner-folded rows, ranked by dps desc then entityId asc (stable). */
  actors: ActorStatsRow[];
  provenance: Provenance;
}

/** The single view-model the desktop tracker renders (spec §4). */
export interface LiveView {
  status: ServiceStatus;
  lastError: string | null;
  watermark: { byteOffset: number; seq: number };
  /** Log clock: ts of the most recent ingested event, or null when none. */
  updatedTs: number | null;
  character: { entityId: number; name: string | null } | null;
  /** The open session, else the latest; null when there are no sessions. */
  currentSession: SessionSummary | null;
  /** The active encounter in the current session, if any. */
  currentEncounter: EncounterView | null;
  /** Closed encounters in the current session, newest-first, capped at recentLimit. */
  recentEncounters: EncounterHeader[];
}

/** Stable actor ranking: dps desc, then entityId asc to break ties deterministically. */
function rankActors(rows: readonly ActorStatsRow[]): ActorStatsRow[] {
  return [...rows].sort((a, b) => (b.dps - a.dps) || (a.entityId - b.entityId));
}

function characterName(db: SqlDatabase, entityId: number): string | null {
  const row = db
    .prepare("SELECT canonical_name AS name FROM entities WHERE id = ?")
    .get(entityId) as { name: string } | undefined;
  return row?.name ?? null;
}

function latestEventTs(db: SqlDatabase, logFileId: number): number | null {
  const row = db
    .prepare("SELECT ts FROM events WHERE log_file_id = ? ORDER BY seq DESC LIMIT 1")
    .get(logFileId) as { ts: number } | undefined;
  return row?.ts ?? null;
}

/**
 * Derive the full {@link LiveView} from current projection state — a pure
 * function of the DB (spec §4). Runs no ingest and no projection catch-up; the
 * service calls `updateProjections` before this when it wants the head.
 */
export function deriveLiveView(
  db: SqlDatabase,
  logFileId: number,
  status: ServiceStatus,
  lastError: string | null,
  recentLimit: number,
): LiveView {
  const watermark = getWatermark(db, logFileId);
  const updatedTs = latestEventTs(db, logFileId);

  // currentSession: the open session (endedTs null; at most one under single-file
  // segmentation), else the latest by startedTs.
  const sessions = getSessions(db, logFileId);
  let current = null as (typeof sessions)[number] | null;
  for (const s of sessions) {
    if (s.endedTs === null) {
      current = s;
      break;
    }
    if (current === null || s.startedTs > current.startedTs) current = s;
  }

  if (current === null) {
    return {
      status,
      lastError,
      watermark,
      updatedTs,
      character: null,
      currentSession: null,
      currentEncounter: null,
      recentEncounters: [],
    };
  }

  const currentSession: SessionSummary | null = getSessionSummary(db, current.id);
  const character =
    current.characterEntityId === null
      ? null
      : { entityId: current.characterEntityId, name: characterName(db, current.characterEntityId) };

  const encounters = listEncounters(db, { sessionId: current.id });
  const active = encounters.find((e) => e.status === "active") ?? null;
  const closed = encounters
    .filter((e) => e.status === "closed")
    .sort((a, b) => (b.startedTs - a.startedTs) || (b.id - a.id))
    .slice(0, recentLimit);

  let currentEncounter: EncounterView | null = null;
  if (active !== null) {
    const stats = getActorStats(db, { encounterId: active.id, foldPets: true });
    currentEncounter = {
      header: active,
      actors: rankActors(stats.rows),
      provenance: stats.provenance,
    };
  }

  return {
    status,
    lastError,
    watermark,
    updatedTs,
    character,
    currentSession,
    currentEncounter,
    recentEncounters: closed,
  };
}
