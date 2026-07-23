/**
 * encounter_actor_stats projector (docs/PROJECTIONS_SPEC.md §6).
 *
 * Credits each attaching contribution to its attributed ally actor: damage split
 * melee/spell/dot/ds, hit/miss/max_hit, heal_total/overheal_total. The actor row
 * is keyed by the ACTUAL actor entity (a pet keeps its own row); `attrib_owner_id`
 * carries the pet→owner fold so owner-rollup is the query
 * `GROUP BY COALESCE(attrib_owner_id, entity_id)`. `duration_ms` tracks the
 * encounter span; `active_stance`/`active_invocation` are the owner's state at
 * the encounter's start (derived from the last stance/invocation change at or
 * before `started_ts`). No in-memory row state: the table itself is the
 * accumulator (idempotent additive upserts), so incremental == rebuild.
 */

import { analyzeContribution } from "../combat.js";
import type { PassContext, PassEvent, Projector } from "./types.js";

interface StartState {
  startedTs: number;
  stance: string | null;
  invocation: string | null;
}

const UPSERT = `INSERT INTO encounter_actor_stats
  (encounter_id, entity_id, attrib_owner_id, damage_total, melee_damage, spell_damage,
   dot_damage, ds_damage, hit_count, miss_count, max_hit, heal_total, overheal_total,
   duration_ms, active_stance, active_invocation)
  VALUES (@enc, @ent, @owner, @dtot, @melee, @spell, @dot, @ds, @hit, @miss, @max,
          @heal, @over, 0, @stance, @invocation)
  ON CONFLICT(encounter_id, entity_id) DO UPDATE SET
    attrib_owner_id = @owner,
    damage_total = damage_total + @dtot,
    melee_damage = melee_damage + @melee,
    spell_damage = spell_damage + @spell,
    dot_damage   = dot_damage + @dot,
    ds_damage    = ds_damage + @ds,
    hit_count    = hit_count + @hit,
    miss_count   = miss_count + @miss,
    max_hit      = MAX(max_hit, @max),
    heal_total   = heal_total + @heal,
    overheal_total = overheal_total + @over`;

export function createActorStatsProjector(): Projector {
  const startCache = new Map<number, StartState>();

  function startStateFor(ctx: PassContext, encounterId: number, logFileId: number): StartState {
    const cached = startCache.get(encounterId);
    if (cached !== undefined) return cached;
    const enc = ctx.db
      .prepare("SELECT started_ts FROM encounters WHERE id = ?")
      .get(encounterId) as { started_ts: number } | undefined;
    // The encounter's opener is the lowest-id event attached to it. Bound the
    // stance/invocation lookup by that event id — i.e. by (log_file_id, seq)
    // order, NOT ts alone (ordering amendment) — so a same-second stance change
    // with a LATER seq than the opener is not mistaken for the opener's stance.
    const opener = ctx.db
      .prepare("SELECT MIN(id) AS id FROM events WHERE encounter_id = ?")
      .get(encounterId) as { id: number | null };
    const openerId = opener.id ?? 0;
    const state: StartState = {
      startedTs: enc?.started_ts ?? 0,
      stance: latestStringField(ctx, "stance_change", "stance", logFileId, openerId),
      invocation: latestStringField(ctx, "invocation_change", "invocation", logFileId, openerId),
    };
    startCache.set(encounterId, state);
    return state;
  }

  return {
    name: "encounter_actor_stats",
    version: 1,
    tablesOwned: ["encounter_actor_stats"],

    load(): void {
      startCache.clear();
    },

    apply(ctx: PassContext, pe: PassEvent): void {
      const encounterId = pe.encounterId;
      if (encounterId === null) return;

      const contribution = analyzeContribution(ctx, pe.event);
      if (contribution !== null) {
        const start = startStateFor(ctx, encounterId, pe.event.logFileId);
        const k = contribution.damageKind;
        const dmg = contribution.isMiss || contribution.isHeal ? 0 : contribution.amount;
        ctx.db.prepare(UPSERT).run({
          enc: encounterId,
          ent: contribution.actorId,
          owner: contribution.attribOwnerId,
          dtot: dmg,
          melee: k === "melee" ? dmg : 0,
          spell: k === "spell" ? dmg : 0,
          dot: k === "dot" ? dmg : 0,
          ds: k === "ds" ? dmg : 0,
          hit: !contribution.isMiss && !contribution.isHeal ? 1 : 0,
          miss: contribution.isMiss ? 1 : 0,
          max: dmg,
          heal: contribution.isHeal ? contribution.amount : 0,
          over:
            contribution.isHeal && contribution.uncapped !== null
              ? Math.max(0, contribution.uncapped - contribution.amount)
              : 0,
          stance: start.stance,
          invocation: start.invocation,
        });
      }

      // Refresh the encounter span onto every actor row (covers enemy-attach
      // events too), so the stored duration equals the final back-dated span.
      ctx.db
        .prepare(
          `UPDATE encounter_actor_stats
             SET duration_ms = (SELECT ended_ts - started_ts FROM encounters WHERE id = @enc)
           WHERE encounter_id = @enc`,
        )
        .run({ enc: encounterId });
    },

    reset(ctx: PassContext): void {
      ctx.db.exec("DELETE FROM encounter_actor_stats");
    },
  };
}

/**
 * The most recent value of a string field from `type` events at or before the
 * opener event, ordered by id (= (log_file_id, seq), the canonical order — never
 * ts alone).
 */
function latestStringField(
  ctx: PassContext,
  type: string,
  field: string,
  logFileId: number,
  openerId: number,
): string | null {
  const row = ctx.db
    .prepare(
      `SELECT payload FROM events
       WHERE type = ? AND log_file_id = ? AND id <= ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(type, logFileId, openerId) as { payload: string } | undefined;
  if (row === undefined) return null;
  const parsed = JSON.parse(row.payload) as Record<string, unknown>;
  const value = parsed[field];
  return typeof value === "string" ? value : null;
}
