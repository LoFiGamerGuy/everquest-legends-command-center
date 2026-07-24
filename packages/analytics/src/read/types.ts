/**
 * Plain typed records returned by the read/query API (docs/PROJECTIONS_SPEC.md
 * §8). Every field a UI needs is here; nothing rests on an ORM. Aggregates that
 * depend on attribution carry a `provenance.minConfidence` so the UI never
 * renders a guess as fact (spec §8).
 */

export interface SessionRecord {
  id: number;
  logFileId: number;
  startedTs: number;
  endedTs: number | null;
  characterEntityId: number | null;
}

export interface SessionSummary {
  sessionId: number;
  startedTs: number;
  endedTs: number | null;
  /** Wall span (uses last event ts while the session is open). */
  spanMs: number;
  /** Σ encounter duration_ms in the session (spec §7). */
  activeMs: number;
  /** spanMs − activeMs. */
  afkMs: number;
  encounterCount: number;
  /** Σ xp percent-milli in the session (level-ups excluded; they carry 0). */
  xpPercentMilli: number;
  /** percent-milli per wall hour. */
  xpPerHour: number;
  /** Σ currency_ledger delta (copper). */
  coinCopper: number;
  /** copper per wall hour. */
  coinPerHour: number;
  zones: string[];
}

export interface EncounterHeader {
  id: number;
  sessionId: number;
  zoneId: number | null;
  zoneName: string | null;
  name: string | null;
  primaryTargetEntityId: number | null;
  startedTs: number;
  endedTs: number | null;
  status: "active" | "closed";
  scale: "group" | "raid";
  difficultyTier: string | null;
  durationMs: number;
  topActorEntityId: number | null;
  topActorName: string | null;
  /** Owner-folded top-actor DPS (damage / seconds). */
  topActorDps: number;
}

export interface ActorStatsRow {
  entityId: number;
  entityName: string;
  attribOwnerId: number | null;
  damageTotal: number;
  meleeDamage: number;
  spellDamage: number;
  dotDamage: number;
  dsDamage: number;
  hitCount: number;
  missCount: number;
  maxHit: number;
  healTotal: number;
  overhealTotal: number;
  durationMs: number;
  dps: number;
  hps: number;
  activeStance: string | null;
  activeInvocation: string | null;
}

export interface Provenance {
  /** Minimum attribution confidence across the included rows (0–1). */
  minConfidence: number;
}

export interface ActorStatsResult {
  rows: ActorStatsRow[];
  provenance: Provenance;
}

export interface ParticipantRecord {
  entityId: number;
  entityName: string;
  role: "ally" | "enemy" | "unknown";
  evidenceType: string;
  confidence: number;
}

export interface BucketRecord {
  entityId: number;
  bucketTs: number;
  damage: number;
  healing: number;
}

export interface EncounterDetail {
  header: EncounterHeader;
  participants: ParticipantRecord[];
  /** Per-actor rows (a pet keeps its own row). */
  actors: ActorStatsResult;
  /** Owner-folded rows (COALESCE(attrib_owner_id, entity_id)). */
  actorsFolded: ActorStatsResult;
  buckets: BucketRecord[];
}

export interface XpRate {
  sessionId: number;
  totalPercentMilli: number;
  attributedPercentMilli: number;
  spanMs: number;
  xpPerHour: number;
  killCount: number;
}

export interface LootRecord {
  eventId: number;
  ts: number;
  sessionId: number | null;
  itemName: string;
  quantity: number;
  corpseName: string | null;
  mode: "kept" | "auto_sold";
  saleTotalCopper: number | null;
}

export interface CurrencyRecord {
  eventId: number;
  ts: number;
  sessionId: number | null;
  deltaCopper: number;
  reason: string;
}

export interface FactionRecord {
  eventId: number;
  ts: number;
  sessionId: number | null;
  factionName: string;
  delta: number;
}

export type ExperimentDimension = "stance" | "invocation" | "weapon" | "zone" | "difficulty";
export type ExperimentMetric = "dps" | "hps" | "xp_per_hr";

export interface ExperimentGroup {
  value: string;
  /** Sample size (encounters). */
  n: number;
  mean: number;
  ciLow: number;
  ciHigh: number;
}

export interface ExperimentBreakdown {
  dimension: ExperimentDimension;
  metric: ExperimentMetric;
  minN: number;
  groups: ExperimentGroup[];
  /** The winning group, or null when honesty rules refuse to name one. */
  winner: { value: string; mean: number } | null;
  winnerRefusedReason: string | null;
}
