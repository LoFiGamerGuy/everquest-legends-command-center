/**
 * Session read API (docs/PROJECTIONS_SPEC.md §8): getSessions, getSessionSummary.
 * Session analytics (active/afk ms, xp/hr, coin/hr) are computed on read (spec
 * §7 — not a table in M1).
 */

import type { Db } from "../projectors/types.js";
import type { SessionRecord, SessionSummary } from "./types.js";

interface SessionRow {
  id: number;
  log_file_id: number;
  started_ts: number;
  ended_ts: number | null;
  character_entity_id: number | null;
}

const SESSION_COLUMNS = "id, log_file_id, started_ts, ended_ts, character_entity_id";

export function getSessions(db: Db, logFileId?: number): SessionRecord[] {
  const rows = (
    logFileId === undefined
      ? db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY started_ts, id`).all()
      : db
          .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE log_file_id = ? ORDER BY started_ts, id`)
          .all(logFileId)
  ) as SessionRow[];
  return rows.map((r) => ({
    id: r.id,
    logFileId: r.log_file_id,
    startedTs: r.started_ts,
    endedTs: r.ended_ts,
    characterEntityId: r.character_entity_id,
  }));
}

export function getSessionSummary(db: Db, sessionId: number): SessionSummary | null {
  const s = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`).get(sessionId) as
    | SessionRow
    | undefined;
  if (s === undefined) return null;

  const lastTs =
    s.ended_ts ??
    (
      db.prepare("SELECT MAX(ts) AS t FROM events WHERE session_id = ?").get(sessionId) as {
        t: number | null;
      }
    ).t ??
    s.started_ts;
  const spanMs = Math.max(0, lastTs - s.started_ts);

  const activeMs =
    (
      db
        .prepare("SELECT COALESCE(SUM(ended_ts - started_ts), 0) AS a FROM encounters WHERE session_id = ?")
        .get(sessionId) as { a: number }
    ).a ?? 0;
  const encounterCount = (
    db.prepare("SELECT COUNT(*) AS c FROM encounters WHERE session_id = ?").get(sessionId) as {
      c: number;
    }
  ).c;
  const xpPercentMilli = (
    db
      .prepare("SELECT COALESCE(SUM(percent_milli), 0) AS x FROM xp_events WHERE session_id = ? AND kind = 'normal'")
      .get(sessionId) as { x: number }
  ).x;
  const coinCopper = (
    db
      .prepare("SELECT COALESCE(SUM(delta_copper), 0) AS c FROM currency_ledger WHERE session_id = ?")
      .get(sessionId) as { c: number }
  ).c;
  const zones = (
    db
      .prepare(
        `SELECT z.name AS name, MIN(zv.entered_ts) AS first_ts
         FROM zone_visits zv JOIN zones z ON z.id = zv.zone_id
         WHERE zv.session_id = ? GROUP BY z.name ORDER BY first_ts, z.name`,
      )
      .all(sessionId) as { name: string }[]
  ).map((r) => r.name);

  const hours = spanMs / 3_600_000;
  return {
    sessionId,
    startedTs: s.started_ts,
    endedTs: s.ended_ts,
    spanMs,
    activeMs,
    afkMs: Math.max(0, spanMs - activeMs),
    encounterCount,
    xpPercentMilli,
    xpPerHour: hours > 0 ? xpPercentMilli / hours : 0,
    coinCopper,
    coinPerHour: hours > 0 ? coinCopper / hours : 0,
    zones,
  };
}
