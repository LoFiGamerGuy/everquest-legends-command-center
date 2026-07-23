/**
 * Economy / progression read API (docs/PROJECTIONS_SPEC.md §8): getXpRate,
 * getLoot, getCurrency, getFactionChanges.
 */

import type { Db } from "../projectors/types.js";
import type { CurrencyRecord, FactionRecord, LootRecord, XpRate } from "./types.js";

export function getXpRate(db: Db, sessionId: number): XpRate {
  const total = (
    db
      .prepare("SELECT COALESCE(SUM(percent_milli), 0) AS x FROM xp_events WHERE session_id = ? AND kind = 'normal'")
      .get(sessionId) as { x: number }
  ).x;
  const attributed = (
    db
      .prepare(
        `SELECT COALESCE(SUM(percent_milli), 0) AS x FROM xp_events
         WHERE session_id = ? AND kind = 'normal' AND attributed_encounter_id IS NOT NULL`,
      )
      .get(sessionId) as { x: number }
  ).x;
  const killCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM events e
         JOIN encounters en ON en.id = e.encounter_id
         WHERE e.type = 'kill' AND en.session_id = ?`,
      )
      .get(sessionId) as { c: number }
  ).c;
  const span = sessionSpan(db, sessionId);
  const hours = span / 3_600_000;
  return {
    sessionId,
    totalPercentMilli: total,
    attributedPercentMilli: attributed,
    spanMs: span,
    xpPerHour: hours > 0 ? total / hours : 0,
    killCount,
  };
}

function sessionSpan(db: Db, sessionId: number): number {
  const s = db.prepare("SELECT started_ts, ended_ts FROM sessions WHERE id = ?").get(sessionId) as
    | { started_ts: number; ended_ts: number | null }
    | undefined;
  if (s === undefined) return 0;
  const last =
    s.ended_ts ??
    (db.prepare("SELECT MAX(ts) AS t FROM events WHERE session_id = ?").get(sessionId) as {
      t: number | null;
    }).t ??
    s.started_ts;
  return Math.max(0, last - s.started_ts);
}

export function getLoot(db: Db, filter: { sessionId?: number } = {}): LootRecord[] {
  const rows = (
    filter.sessionId === undefined
      ? db.prepare("SELECT * FROM loot_events ORDER BY ts, id").all()
      : db.prepare("SELECT * FROM loot_events WHERE session_id = ? ORDER BY ts, id").all(filter.sessionId)
  ) as {
    event_id: number;
    ts: number;
    session_id: number | null;
    item_name: string;
    quantity: number;
    corpse_name: string | null;
    mode: "kept" | "auto_sold";
    sale_total_copper: number | null;
  }[];
  return rows.map((r) => ({
    eventId: r.event_id,
    ts: r.ts,
    sessionId: r.session_id,
    itemName: r.item_name,
    quantity: r.quantity,
    corpseName: r.corpse_name,
    mode: r.mode,
    saleTotalCopper: r.sale_total_copper,
  }));
}

export function getCurrency(db: Db, filter: { sessionId?: number } = {}): CurrencyRecord[] {
  const rows = (
    filter.sessionId === undefined
      ? db.prepare("SELECT * FROM currency_ledger ORDER BY ts, id").all()
      : db.prepare("SELECT * FROM currency_ledger WHERE session_id = ? ORDER BY ts, id").all(filter.sessionId)
  ) as { event_id: number; ts: number; session_id: number | null; delta_copper: number; reason: string }[];
  return rows.map((r) => ({
    eventId: r.event_id,
    ts: r.ts,
    sessionId: r.session_id,
    deltaCopper: r.delta_copper,
    reason: r.reason,
  }));
}

export function getFactionChanges(db: Db, sessionId: number): FactionRecord[] {
  const rows = db
    .prepare("SELECT * FROM faction_events WHERE session_id = ? ORDER BY ts, id")
    .all(sessionId) as {
    event_id: number;
    ts: number;
    session_id: number | null;
    faction_name: string;
    delta: number;
  }[];
  return rows.map((r) => ({
    eventId: r.event_id,
    ts: r.ts,
    sessionId: r.session_id,
    factionName: r.faction_name,
    delta: r.delta,
  }));
}
