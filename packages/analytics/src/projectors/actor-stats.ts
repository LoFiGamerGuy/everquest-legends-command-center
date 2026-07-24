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
 * before the encounter's opener event). No in-memory row state: the table itself
 * is the accumulator (idempotent additive upserts), so incremental == rebuild.
 *
 * Perf (E1.3 / issue #21): the opener's stance/invocation used to be a
 * `SELECT … WHERE type=? ORDER BY id DESC LIMIT 1` per new encounter. Those rare
 * event types have no usable index for that shape, so each call scanned the whole
 * (single-file) events table — O(n) per encounter, O(n²) over a rebuild (the
 * measured superlinear hotspot). We now track the owner's current stance/
 * invocation as in-memory state advanced over the pass (like the driver's other
 * projector state): a new encounter's opener is, by construction, the FIRST event
 * the projector applies for that encounter, so the live value at that moment IS
 * the opener's state. For encounters left `active` across a pass boundary the
 * opener is historical, so {@link Projector.load} rebuilds their start-state cache
 * from the persisted rows — keeping incremental == rebuild byte-identical while a
 * from-scratch rebuild does zero such scans.
 */

import { analyzeContribution } from "../combat.js";
import type { PassContext, PassEvent, Projector } from "./types.js";

interface StartState {
  startedTs: number;
  stance: string | null;
  invocation: string | null;
  /** The encounter's known enemy (primary_target_entity_id); never booked as an ally. */
  enemyId: number | null;
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
  // The owner's current stance/invocation, advanced in event order over the pass
  // (see the perf note above). Reconstructed at pass start from persisted events.
  let liveStance: string | null = null;
  let liveInvocation: string | null = null;

  function startStateFor(ctx: PassContext, encounterId: number): StartState {
    const cached = startCache.get(encounterId);
    if (cached !== undefined) return cached;
    // Cache miss ⇒ this is the encounter's opener (its first applied event this
    // pass); the live stance/invocation is exactly the opener's state. Encounters
    // that opened in an earlier pass are pre-seeded in `load`, so they hit above.
    const enc = ctx.db
      .prepare("SELECT started_ts, primary_target_entity_id FROM encounters WHERE id = ?")
      .get(encounterId) as { started_ts: number; primary_target_entity_id: number | null } | undefined;
    const state: StartState = {
      startedTs: enc?.started_ts ?? 0,
      stance: liveStance,
      invocation: liveInvocation,
      enemyId: enc?.primary_target_entity_id ?? null,
    };
    startCache.set(encounterId, state);
    return state;
  }

  return {
    name: "encounter_actor_stats",
    version: 1,
    tablesOwned: ["encounter_actor_stats"],

    load(ctx: PassContext, watermark: number): void {
      startCache.clear();
      // Reconstruct the live stance/invocation as of the watermark (the state a
      // from-scratch replay would hold at this point) — one bounded lookup each,
      // per pass, replacing the old per-encounter scans.
      liveStance = latestStringField(ctx, "stance_change", "stance", ctx.logFileId, watermark);
      liveInvocation = latestStringField(ctx, "invocation_change", "invocation", ctx.logFileId, watermark);
      // Encounters still `active` across this pass boundary have a HISTORICAL
      // opener, so their start-state can't come from the live value. Rebuild their
      // cache from the opener event (bounded: only concurrently-open fights are
      // active; a from-scratch rebuild resets encounters first, so this is empty).
      const active = ctx.db
        .prepare(
          `SELECT e.id AS id, e.started_ts AS started_ts,
                  e.primary_target_entity_id AS enemy, MIN(ev.id) AS opener
           FROM encounters e JOIN events ev ON ev.encounter_id = e.id
           WHERE e.status = 'active'
           GROUP BY e.id`,
        )
        .all() as {
        id: number;
        started_ts: number;
        enemy: number | null;
        opener: number | null;
      }[];
      for (const r of active) {
        const openerId = r.opener ?? 0;
        startCache.set(r.id, {
          startedTs: r.started_ts ?? 0,
          stance: latestStringField(ctx, "stance_change", "stance", ctx.logFileId, openerId),
          invocation: latestStringField(ctx, "invocation_change", "invocation", ctx.logFileId, openerId),
          enemyId: r.enemy ?? null,
        });
      }
    },

    apply(ctx: PassContext, pe: PassEvent): void {
      // Advance the owner's live state in event order (rare types; cheap).
      if (pe.event.type === "stance_change") {
        liveStance = pe.event.stance;
        return;
      }
      if (pe.event.type === "invocation_change") {
        liveInvocation = pe.event.invocation;
        return;
      }
      const encounterId = pe.encounterId;
      if (encounterId === null) return;

      const start = startStateFor(ctx, encounterId);
      const contribution = analyzeContribution(ctx, pe.event, start.enemyId);
      if (contribution !== null) {
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
