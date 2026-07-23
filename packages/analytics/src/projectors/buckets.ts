/**
 * encounter_buckets projector (docs/PROJECTIONS_SPEC.md §6).
 *
 * Per-(encounter, entity, unix-second) damage/healing for live meters and
 * charts. Keyed on the actual acting entity (like actor-stats); folding to an
 * owner is a query concern. Pure additive upserts — no in-memory state — so a
 * leaf-only rebuild (version bump) reconstructs it from `events` + the persisted
 * `events.encounter_id` without touching any other projector.
 */

import { analyzeContribution } from "../combat.js";
import type { PassContext, PassEvent, Projector } from "./types.js";

const UPSERT = `INSERT INTO encounter_buckets (encounter_id, entity_id, bucket_ts, damage, healing)
  VALUES (@enc, @ent, @bucket, @damage, @healing)
  ON CONFLICT(encounter_id, entity_id, bucket_ts) DO UPDATE SET
    damage = damage + @damage,
    healing = healing + @healing`;

export function createBucketsProjector(): Projector {
  // Per-pass cache of an encounter's known enemy (primary_target_entity_id), so
  // the enemy's own output is never bucketed as ally damage/healing (MAJOR 2).
  const enemyCache = new Map<number, number | null>();
  function enemyOf(ctx: PassContext, encounterId: number): number | null {
    const cached = enemyCache.get(encounterId);
    if (cached !== undefined) return cached;
    const row = ctx.db
      .prepare("SELECT primary_target_entity_id AS e FROM encounters WHERE id = ?")
      .get(encounterId) as { e: number | null } | undefined;
    const enemyId = row?.e ?? null;
    enemyCache.set(encounterId, enemyId);
    return enemyId;
  }

  return {
    name: "encounter_buckets",
    version: 1,
    tablesOwned: ["encounter_buckets"],

    load(): void {
      enemyCache.clear();
    },

    apply(ctx: PassContext, pe: PassEvent): void {
      const encounterId = pe.encounterId;
      if (encounterId === null) return;
      const c = analyzeContribution(ctx, pe.event, enemyOf(ctx, encounterId));
      if (c === null || c.isMiss) return;
      const damage = c.isHeal ? 0 : c.amount;
      const healing = c.isHeal ? c.amount : 0;
      if (damage === 0 && healing === 0) return;
      ctx.db.prepare(UPSERT).run({
        enc: encounterId,
        ent: c.actorId,
        bucket: Math.floor(pe.event.ts / 1000),
        damage,
        healing,
      });
    },

    reset(ctx: PassContext): void {
      ctx.db.exec("DELETE FROM encounter_buckets");
    },
  };
}
