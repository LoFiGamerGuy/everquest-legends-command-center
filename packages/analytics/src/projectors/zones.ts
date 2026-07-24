/**
 * Zones / zone_visits projector (docs/PROJECTIONS_SPEC.md §4).
 *
 * Each `zone_enter` upserts `zones(name)`, closes the current `zone_visits` row
 * for the session (`left_ts`) and opens a new one. `is_instance` is the
 * UNVERIFIED "… Expedition" suffix heuristic (never load-bearing). Open-visit
 * state is reconstructed in {@link load} from rows with a NULL `left_ts`.
 */

import type { PassContext, PassEvent, Projector } from "./types.js";

/** UNVERIFIED (spec §4): an instance zone name ends in "Expedition". */
export function isInstanceZoneName(name: string): boolean {
  return /\bExpedition$/.test(name.trim());
}

export function createZonesProjector(): Projector {
  /** session_id → open zone_visit id. */
  const openVisit = new Map<number, number>();

  function upsertZone(ctx: PassContext, name: string): number {
    ctx.db
      .prepare("INSERT INTO zones (name, is_instance) VALUES (?, ?) ON CONFLICT(name) DO NOTHING")
      .run(name, isInstanceZoneName(name) ? 1 : 0);
    const row = ctx.db.prepare("SELECT id FROM zones WHERE name = ?").get(name) as { id: number };
    return row.id;
  }

  return {
    name: "zones",
    version: 1,
    tablesOwned: ["zones", "zone_visits"],

    load(ctx: PassContext): void {
      openVisit.clear();
      const rows = ctx.db
        .prepare("SELECT id, session_id FROM zone_visits WHERE left_ts IS NULL")
        .all() as { id: number; session_id: number }[];
      for (const r of rows) openVisit.set(r.session_id, r.id);
    },

    apply(ctx: PassContext, pe: PassEvent): void {
      if (pe.event.type !== "zone_enter") return;
      const sessionId = pe.sessionId;
      if (sessionId === null) return; // sessions always assigns first; defensive
      const ts = pe.event.ts;
      const zoneId = upsertZone(ctx, pe.event.zone);

      const prev = openVisit.get(sessionId);
      if (prev !== undefined) {
        ctx.db.prepare("UPDATE zone_visits SET left_ts = ? WHERE id = ?").run(ts, prev);
      }
      const info = ctx.db
        .prepare(
          "INSERT INTO zone_visits (session_id, zone_id, entered_ts, left_ts) VALUES (?, ?, ?, NULL)",
        )
        .run(sessionId, zoneId, ts);
      openVisit.set(sessionId, Number(info.lastInsertRowid));
    },

    reset(ctx: PassContext): void {
      ctx.db.exec("DELETE FROM zone_visits");
      ctx.db.exec("DELETE FROM zones");
    },
  };
}
