/**
 * Encounter read API (docs/PROJECTIONS_SPEC.md §8): listEncounters, getEncounter,
 * getActorStats. Parameterized SQL, plain typed records. Owner-folded views use
 * `GROUP BY COALESCE(attrib_owner_id, entity_id)`; DPS/HPS use the community
 * denominator `duration_ms` (encounter span). Every attribution-dependent
 * aggregate carries `provenance.minConfidence` (spec §8).
 */

import type { Db } from "../projectors/types.js";
import type {
  ActorStatsResult,
  ActorStatsRow,
  BucketRecord,
  EncounterDetail,
  EncounterHeader,
  ParticipantRecord,
} from "./types.js";

export interface ListEncountersFilter {
  sessionId?: number;
  zoneId?: number;
  scale?: "group" | "raid";
  since?: number;
}

interface EncounterRow {
  id: number;
  session_id: number;
  zone_id: number | null;
  zone_name: string | null;
  name: string | null;
  primary_target_entity_id: number | null;
  started_ts: number;
  ended_ts: number | null;
  status: "active" | "closed";
  scale: "group" | "raid";
  difficulty_tier: string | null;
}

function toHeader(db: Db, r: EncounterRow): EncounterHeader {
  const durationMs = (r.ended_ts ?? r.started_ts) - r.started_ts;
  const top = topActor(db, r.id, durationMs);
  return {
    id: r.id,
    sessionId: r.session_id,
    zoneId: r.zone_id,
    zoneName: r.zone_name,
    name: r.name,
    primaryTargetEntityId: r.primary_target_entity_id,
    startedTs: r.started_ts,
    endedTs: r.ended_ts,
    status: r.status,
    scale: r.scale,
    difficultyTier: r.difficulty_tier,
    durationMs,
    topActorEntityId: top?.entityId ?? null,
    topActorName: top?.entityName ?? null,
    topActorDps: top?.dps ?? 0,
  };
}

function topActor(
  db: Db,
  encounterId: number,
  durationMs: number,
): { entityId: number; entityName: string; dps: number } | null {
  const row = db
    .prepare(
      `SELECT COALESCE(attrib_owner_id, entity_id) AS entity_id,
              SUM(damage_total) AS dmg
       FROM encounter_actor_stats WHERE encounter_id = ?
       GROUP BY COALESCE(attrib_owner_id, entity_id)
       ORDER BY dmg DESC, entity_id ASC LIMIT 1`,
    )
    .get(encounterId) as { entity_id: number; dmg: number } | undefined;
  if (row === undefined || row.dmg === 0) return null;
  const name = entityName(db, row.entity_id);
  const dps = durationMs > 0 ? row.dmg / (durationMs / 1000) : 0;
  return { entityId: row.entity_id, entityName: name, dps };
}

function entityName(db: Db, id: number): string {
  const row = db.prepare("SELECT canonical_name AS n FROM entities WHERE id = ?").get(id) as
    | { n: string }
    | undefined;
  return row?.n ?? String(id);
}

export function listEncounters(db: Db, filter: ListEncountersFilter = {}): EncounterHeader[] {
  const clauses: string[] = [];
  const params: Record<string, number | string> = {};
  if (filter.sessionId !== undefined) {
    clauses.push("e.session_id = @sessionId");
    params.sessionId = filter.sessionId;
  }
  if (filter.zoneId !== undefined) {
    clauses.push("e.zone_id = @zoneId");
    params.zoneId = filter.zoneId;
  }
  if (filter.scale !== undefined) {
    clauses.push("e.scale = @scale");
    params.scale = filter.scale;
  }
  if (filter.since !== undefined) {
    clauses.push("e.started_ts >= @since");
    params.since = filter.since;
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT e.id, e.session_id, e.zone_id, z.name AS zone_name, e.name,
              e.primary_target_entity_id, e.started_ts, e.ended_ts, e.status, e.scale, e.difficulty_tier
       FROM encounters e LEFT JOIN zones z ON z.id = e.zone_id
       ${where}
       ORDER BY e.started_ts ASC, e.id ASC`,
    )
    .all(params) as EncounterRow[];
  return rows.map((r) => toHeader(db, r));
}

export function getEncounter(db: Db, encounterId: number): EncounterDetail | null {
  const r = db
    .prepare(
      `SELECT e.id, e.session_id, e.zone_id, z.name AS zone_name, e.name,
              e.primary_target_entity_id, e.started_ts, e.ended_ts, e.status, e.scale, e.difficulty_tier
       FROM encounters e LEFT JOIN zones z ON z.id = e.zone_id
       WHERE e.id = ?`,
    )
    .get(encounterId) as EncounterRow | undefined;
  if (r === undefined) return null;
  const header = toHeader(db, r);
  const participants = db
    .prepare(
      `SELECT p.entity_id, en.canonical_name AS entity_name, p.role, p.evidence_type, p.confidence
       FROM encounter_participants p JOIN entities en ON en.id = p.entity_id
       WHERE p.encounter_id = ? ORDER BY p.role, p.entity_id`,
    )
    .all(encounterId)
    .map(
      (row): ParticipantRecord => {
        const p = row as {
          entity_id: number;
          entity_name: string;
          role: "ally" | "enemy" | "unknown";
          evidence_type: string;
          confidence: number;
        };
        return {
          entityId: p.entity_id,
          entityName: p.entity_name,
          role: p.role,
          evidenceType: p.evidence_type,
          confidence: p.confidence,
        };
      },
    );
  const buckets = db
    .prepare(
      `SELECT entity_id, bucket_ts, damage, healing FROM encounter_buckets
       WHERE encounter_id = ? ORDER BY bucket_ts, entity_id`,
    )
    .all(encounterId)
    .map((row): BucketRecord => {
      const b = row as { entity_id: number; bucket_ts: number; damage: number; healing: number };
      return { entityId: b.entity_id, bucketTs: b.bucket_ts, damage: b.damage, healing: b.healing };
    });
  return {
    header,
    participants,
    actors: getActorStats(db, { encounterId, foldPets: false }),
    actorsFolded: getActorStats(db, { encounterId, foldPets: true }),
    buckets,
  };
}

export interface ActorStatsQuery {
  encounterId?: number;
  sessionId?: number;
  foldPets?: boolean;
}

interface AggRow {
  entity_id: number;
  entity_name: string;
  attrib_owner_id: number | null;
  damage_total: number;
  melee_damage: number;
  spell_damage: number;
  dot_damage: number;
  ds_damage: number;
  hit_count: number;
  miss_count: number;
  max_hit: number;
  heal_total: number;
  overheal_total: number;
  duration_ms: number;
  active_stance: string | null;
  active_invocation: string | null;
}

/**
 * Per-actor damage/heal/tank breakdown. `foldPets` groups by
 * `COALESCE(attrib_owner_id, entity_id)` (spec §8). DPS/HPS use `duration_ms`.
 * Duration is summed per distinct encounter (an inner per-encounter fold) so a
 * self+pet fold never double-counts the encounter span.
 */
export function getActorStats(db: Db, query: ActorStatsQuery): ActorStatsResult {
  const foldPets = query.foldPets ?? true;
  const groupKey = foldPets ? "COALESCE(attrib_owner_id, entity_id)" : "entity_id";
  const scope: string[] = [];
  const params: Record<string, number> = {};
  if (query.encounterId !== undefined) {
    scope.push("encounter_id = @encounterId");
    params.encounterId = query.encounterId;
  }
  if (query.sessionId !== undefined) {
    scope.push("encounter_id IN (SELECT id FROM encounters WHERE session_id = @sessionId)");
    params.sessionId = query.sessionId;
  }
  const where = scope.length > 0 ? `WHERE ${scope.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT x.entity_id, en.canonical_name AS entity_name,
              MAX(x.attrib_owner_id) AS attrib_owner_id,
              SUM(x.dmg) AS damage_total, SUM(x.melee) AS melee_damage, SUM(x.spell) AS spell_damage,
              SUM(x.dot) AS dot_damage, SUM(x.ds) AS ds_damage, SUM(x.hit) AS hit_count,
              SUM(x.miss) AS miss_count, MAX(x.maxhit) AS max_hit, SUM(x.heal) AS heal_total,
              SUM(x.over) AS overheal_total, SUM(x.dur) AS duration_ms,
              MIN(x.stance) AS active_stance, MIN(x.invocation) AS active_invocation
       FROM (
         SELECT ${groupKey} AS entity_id, MAX(attrib_owner_id) AS attrib_owner_id, encounter_id,
                SUM(damage_total) AS dmg, SUM(melee_damage) AS melee, SUM(spell_damage) AS spell,
                SUM(dot_damage) AS dot, SUM(ds_damage) AS ds, SUM(hit_count) AS hit,
                SUM(miss_count) AS miss, MAX(max_hit) AS maxhit, SUM(heal_total) AS heal,
                SUM(overheal_total) AS over, MAX(duration_ms) AS dur,
                MIN(active_stance) AS stance, MIN(active_invocation) AS invocation
         FROM encounter_actor_stats ${where}
         GROUP BY encounter_id, ${groupKey}
       ) x JOIN entities en ON en.id = x.entity_id
       GROUP BY x.entity_id
       ORDER BY damage_total DESC, x.entity_id ASC`,
    )
    .all(params) as AggRow[];

  const singleEncounter = query.encounterId !== undefined;
  const result: ActorStatsRow[] = rows.map((r) => {
    const seconds = r.duration_ms > 0 ? r.duration_ms / 1000 : 0;
    return {
      entityId: r.entity_id,
      entityName: r.entity_name,
      attribOwnerId: foldPets ? null : r.attrib_owner_id,
      damageTotal: r.damage_total,
      meleeDamage: r.melee_damage,
      spellDamage: r.spell_damage,
      dotDamage: r.dot_damage,
      dsDamage: r.ds_damage,
      hitCount: r.hit_count,
      missCount: r.miss_count,
      maxHit: r.max_hit,
      healTotal: r.heal_total,
      overhealTotal: r.overheal_total,
      durationMs: r.duration_ms,
      dps: seconds > 0 ? r.damage_total / seconds : 0,
      hps: seconds > 0 ? r.heal_total / seconds : 0,
      // Stance/invocation are per-encounter; only meaningful for a single encounter.
      activeStance: singleEncounter ? r.active_stance : null,
      activeInvocation: singleEncounter ? r.active_invocation : null,
    };
  });

  return { rows: result, provenance: { minConfidence: scopeMinConfidence(db, where, params) } };
}

/** Minimum attribution confidence over the scoped actor rows (spec §8). */
function scopeMinConfidence(db: Db, where: string, params: Record<string, number>): number {
  const row = db
    .prepare(
      `SELECT MIN(conf) AS c FROM (
         SELECT CASE WHEN eas.attrib_owner_id IS NULL THEN 1.0
                     ELSE COALESCE((SELECT el.confidence FROM entity_links el
                                    WHERE el.pet_entity_id = eas.entity_id
                                      AND el.owner_entity_id = eas.attrib_owner_id
                                      AND el.active = 1
                                    ORDER BY el.confidence DESC LIMIT 1), 0.5) END AS conf
         FROM encounter_actor_stats eas ${where}
       )`,
    )
    .get(params) as { c: number | null };
  return row.c ?? 1.0;
}
