/**
 * Domain projections (docs/PROJECTIONS_SPEC.md §7): xp / aa / loot / currency /
 * faction / skill. Mostly 1:1 from a verified event type, each row keyed on its
 * source `event_id` (UNIQUE) so every write is idempotent — re-running at head is
 * a no-op (§9.4).
 *
 *  - xp_events: `xp_gain` → normal, `level_up` → level_up; `attributed_encounter_id`
 *    is the nearest preceding `kill`'s encounter within `xpKillWindowMs`
 *    (evidence `kill_proximity`, confidence by proximity).
 *  - aa_events: `ability_purchase`.
 *  - loot_events: `loot_item` (kept) / `loot_auto_sell` (auto_sold).
 *  - currency_ledger: `auto_sell` from `loot_auto_sell` and `loot_coin` from
 *    `coin_gain` (both corpus-verified). vendor/other reasons stay deferred.
 *  - faction_events: `faction_change`.
 *  - skill_events: `skill_up` (corpus-verified "…better at X! (N)").
 */

import type { PassContext, PassEvent, Projector } from "./types.js";

const DOMAIN_TABLES = [
  "xp_events",
  "aa_events",
  "loot_events",
  "currency_ledger",
  "faction_events",
  "skill_events",
] as const;

interface KillRow {
  encounter_id: number;
  ts: number;
}

export function createDomainProjector(): Projector {
  return {
    name: "domain",
    version: 1,
    tablesOwned: [...DOMAIN_TABLES],

    load(): void {
      /* no in-memory state; xp attribution reads persisted rows */
    },

    apply(ctx: PassContext, pe: PassEvent): void {
      const { db } = ctx;
      const e = pe.event;
      const sessionId = pe.sessionId;

      switch (e.type) {
        case "xp_gain": {
          if (sessionId === null) return;
          const attributed = nearestKill(ctx, pe);
          db.prepare(
            `INSERT INTO xp_events
               (event_id, ts, session_id, percent_milli, level_at_time, kind,
                attributed_encounter_id, evidence_type, confidence)
             VALUES (@event, @ts, @session, @pm, @level, 'normal', @enc, @evidence, @confidence)
             ON CONFLICT(event_id) DO NOTHING`,
          ).run({
            event: pe.id,
            ts: e.ts,
            session: sessionId,
            pm: e.percentMilli,
            level: currentLevel(ctx, pe),
            enc: attributed?.encounterId ?? null,
            evidence: attributed === null ? null : "kill_proximity",
            confidence: attributed?.confidence ?? null,
          });
          return;
        }
        case "level_up": {
          if (sessionId === null) return;
          db.prepare(
            `INSERT INTO xp_events
               (event_id, ts, session_id, percent_milli, level_at_time, kind,
                attributed_encounter_id, evidence_type, confidence)
             VALUES (@event, @ts, @session, 0, @level, 'level_up', NULL, NULL, NULL)
             ON CONFLICT(event_id) DO NOTHING`,
          ).run({ event: pe.id, ts: e.ts, session: sessionId, level: e.level });
          return;
        }
        case "ability_purchase":
          db.prepare(
            `INSERT INTO aa_events (event_id, ts, session_id, ability_name, cost_points)
             VALUES (@event, @ts, @session, @name, @cost)
             ON CONFLICT(event_id) DO NOTHING`,
          ).run({ event: pe.id, ts: e.ts, session: sessionId, name: e.ability, cost: e.costPoints });
          return;
        case "loot_item":
          db.prepare(
            `INSERT INTO loot_events (event_id, ts, session_id, item_name, quantity, corpse_name, mode, sale_total_copper)
             VALUES (@event, @ts, @session, @item, @qty, @corpse, 'kept', NULL)
             ON CONFLICT(event_id) DO NOTHING`,
          ).run({ event: pe.id, ts: e.ts, session: sessionId, item: e.item, qty: e.quantity, corpse: e.corpse });
          return;
        case "loot_auto_sell":
          db.prepare(
            `INSERT INTO loot_events (event_id, ts, session_id, item_name, quantity, corpse_name, mode, sale_total_copper)
             VALUES (@event, @ts, @session, @item, @qty, @corpse, 'auto_sold', @copper)
             ON CONFLICT(event_id) DO NOTHING`,
          ).run({ event: pe.id, ts: e.ts, session: sessionId, item: e.item, qty: e.quantity, corpse: e.corpse, copper: e.totalCopper });
          // Auto-sell is the only VERIFIED coin delta (spec §7).
          db.prepare(
            `INSERT INTO currency_ledger (event_id, ts, session_id, delta_copper, reason)
             VALUES (@event, @ts, @session, @copper, 'auto_sell')
             ON CONFLICT(event_id) DO NOTHING`,
          ).run({ event: pe.id, ts: e.ts, session: sessionId, copper: e.totalCopper });
          return;
        case "coin_gain":
          // coin_gain is corpus-verified (@eqlcc/event-schema): record it as a
          // loot_coin ledger delta. vendor/other reasons stay deferred (still
          // unverified line formats — never invent a coin delta, spec §7).
          db.prepare(
            `INSERT INTO currency_ledger (event_id, ts, session_id, delta_copper, reason)
             VALUES (@event, @ts, @session, @copper, 'loot_coin')
             ON CONFLICT(event_id) DO NOTHING`,
          ).run({ event: pe.id, ts: e.ts, session: sessionId, copper: e.totalCopper });
          return;
        case "faction_change":
          db.prepare(
            `INSERT INTO faction_events (event_id, ts, session_id, faction_name, delta)
             VALUES (@event, @ts, @session, @faction, @delta)
             ON CONFLICT(event_id) DO NOTHING`,
          ).run({ event: pe.id, ts: e.ts, session: sessionId, faction: e.faction, delta: e.delta });
          return;
        case "skill_up":
          // skill_up is corpus-verified ("You have become better at X! (N)").
          db.prepare(
            `INSERT INTO skill_events (event_id, ts, session_id, skill_name, new_value)
             VALUES (@event, @ts, @session, @skill, @value)
             ON CONFLICT(event_id) DO NOTHING`,
          ).run({ event: pe.id, ts: e.ts, session: sessionId, skill: e.skill, value: e.value });
          return;
        default:
          return;
      }
    },

    reset(ctx: PassContext): void {
      for (const t of DOMAIN_TABLES) ctx.db.exec(`DELETE FROM ${t}`);
    },
  };
}

/** Nearest preceding kill's encounter within the XP window (spec §7). */
function nearestKill(
  ctx: PassContext,
  pe: PassEvent,
): { encounterId: number; confidence: number } | null {
  const window = ctx.options.xpKillWindowMs;
  const row = ctx.db
    .prepare(
      `SELECT encounter_id, ts FROM events
       WHERE type = 'kill' AND encounter_id IS NOT NULL AND log_file_id = @lf
         AND ts <= @ts AND ts >= @lo AND id < @id
       ORDER BY id DESC LIMIT 1`,
    )
    .get({ lf: pe.event.logFileId, ts: pe.event.ts, lo: pe.event.ts - window, id: pe.id }) as
    | KillRow
    | undefined;
  if (row === undefined) return null;
  const delta = pe.event.ts - row.ts;
  const confidence = Math.max(0, Math.min(1, 1 - delta / window));
  return { encounterId: row.encounter_id, confidence };
}

/** Character level from the most recent preceding level_up (spec §7). */
function currentLevel(ctx: PassContext, pe: PassEvent): number | null {
  const row = ctx.db
    .prepare(
      `SELECT payload FROM events
       WHERE type = 'level_up' AND log_file_id = ? AND id < ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(pe.event.logFileId, pe.id) as { payload: string } | undefined;
  if (row === undefined) return null;
  const parsed = JSON.parse(row.payload) as { level?: number };
  return typeof parsed.level === "number" ? parsed.level : null;
}
