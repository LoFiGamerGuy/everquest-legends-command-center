/**
 * Sessions projector (docs/PROJECTIONS_SPEC.md §3).
 *
 * The first event of a log file opens a session; it closes on a `log_toggle` OFF
 * or when the gap between consecutive event `ts` exceeds `sessionGapMs`
 * (default 30 min), back-dating `ended_ts` to the last event before the gap. The
 * trailing session stays open (`ended_ts` NULL). Every event's `session_id` is
 * backfilled onto the `events` row so later projectors and domain rows can read
 * it without re-deriving.
 *
 * Cross-pass state (current open session + last event ts) is reconstructed in
 * {@link load} from the persisted rows, so an incremental catch-up splits
 * sessions exactly as a full rebuild would.
 */

import type { PassContext, PassEvent, Projector } from "./types.js";

interface FileState {
  /** Open session id, or null when the previous boundary closed it (→ next event opens a new one). */
  sessionId: number | null;
  /** ts of the last processed event for this file (gap denominator). */
  lastTs: number | null;
}

export function createSessionsProjector(): Projector {
  const state = new Map<number, FileState>();

  function fileState(ctx: PassContext): FileState {
    let s = state.get(ctx.logFileId);
    if (s === undefined) {
      s = { sessionId: null, lastTs: null };
      state.set(ctx.logFileId, s);
    }
    return s;
  }

  function openSession(ctx: PassContext, startedTs: number): number {
    const characterEntityId = ctx.entities.idFor(ctx.ownerId);
    const info = ctx.db
      .prepare(
        `INSERT INTO sessions (log_file_id, started_ts, ended_ts, character_entity_id)
         VALUES (?, ?, NULL, ?)`,
      )
      .run(ctx.logFileId, startedTs, characterEntityId);
    return Number(info.lastInsertRowid);
  }

  function closeSession(ctx: PassContext, sessionId: number, endedTs: number): void {
    ctx.db.prepare("UPDATE sessions SET ended_ts = ? WHERE id = ?").run(endedTs, sessionId);
  }

  return {
    name: "sessions",
    version: 1,
    tablesOwned: ["sessions"],

    load(ctx: PassContext, watermark: number): void {
      state.clear();
      const open = ctx.db
        .prepare(
          `SELECT id FROM sessions
           WHERE log_file_id = ? AND ended_ts IS NULL
           ORDER BY started_ts DESC, id DESC LIMIT 1`,
        )
        .get(ctx.logFileId) as { id: number } | undefined;
      // The last PROCESSED event (id ≤ watermark) — not the last row in the
      // table, which may already hold unprocessed events from this batch.
      const last = ctx.db
        .prepare("SELECT ts FROM events WHERE log_file_id = ? AND id <= ? ORDER BY id DESC LIMIT 1")
        .get(ctx.logFileId, watermark) as { ts: number } | undefined;
      state.set(ctx.logFileId, {
        sessionId: open?.id ?? null,
        lastTs: last?.ts ?? null,
      });
    },

    apply(ctx: PassContext, pe: PassEvent): void {
      const s = fileState(ctx);
      const ts = pe.event.ts;

      if (s.sessionId === null) {
        s.sessionId = openSession(ctx, ts);
      } else if (s.lastTs !== null && ts - s.lastTs > ctx.options.sessionGapMs) {
        closeSession(ctx, s.sessionId, s.lastTs);
        s.sessionId = openSession(ctx, ts);
      }

      pe.sessionId = s.sessionId;
      ctx.db.prepare("UPDATE events SET session_id = ? WHERE id = ?").run(s.sessionId, pe.id);
      s.lastTs = ts;

      // A log-toggle OFF closes the session it belongs to; the next event opens a new one.
      if (pe.event.type === "log_toggle" && pe.event.state === "OFF") {
        closeSession(ctx, s.sessionId, ts);
        s.sessionId = null;
      }
    },

    reset(ctx: PassContext): void {
      ctx.db.exec("UPDATE events SET session_id = NULL");
      ctx.db.exec("DELETE FROM sessions");
    },
  };
}
