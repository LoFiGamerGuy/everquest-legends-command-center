/**
 * @eqlcc/analytics — projection writers + the analytics read/query API
 * (issue #20; docs/PROJECTIONS_SPEC.md). Turns the append-only `events` table
 * into the sessions/zones/encounters/rollups + domain projections (deterministic,
 * incremental, rebuildable) and exposes the thin typed read API the UI consumes.
 *
 * Pure TS over @eqlcc/database, @eqlcc/log-parser, @eqlcc/event-schema.
 */

// Driver (spec §1) — rebuild / incremental catch-up.
export { rebuildProjections, updateProjections } from "./driver.js";
export type { DriverResult } from "./driver.js";

// Optional terminal encounter close for a completed log (spec §5/§8).
export { finalizeEncounters } from "./finalize-encounters.js";
export type { FinalizeEncountersResult } from "./finalize-encounters.js";

// Tunable derivation constants (spec §3–§8).
export {
  DEFAULT_PROJECTION_OPTIONS,
  resolveOptions,
} from "./options.js";
export type {
  ProjectionOptions,
  ProjectionOptionsInput,
  EncounterTimeouts,
  ExperimentOptions,
} from "./options.js";

// Projector registry (advanced use / introspection).
export type { Projector, PassContext, PassEvent } from "./projectors/types.js";
export { isInstanceZoneName } from "./projectors/zones.js";

// Read / query API (spec §8).
export { getSessions, getSessionSummary } from "./read/sessions.js";
export { listEncounters, getEncounter, getActorStats } from "./read/encounters.js";
export type { ListEncountersFilter, ActorStatsQuery } from "./read/encounters.js";
export { getXpRate, getLoot, getCurrency, getFactionChanges } from "./read/economy.js";
export { getExperimentBreakdown } from "./read/experiment.js";
export type { ExperimentQuery } from "./read/experiment.js";

export type {
  SessionRecord,
  SessionSummary,
  EncounterHeader,
  EncounterDetail,
  ActorStatsRow,
  ActorStatsResult,
  ParticipantRecord,
  BucketRecord,
  Provenance,
  XpRate,
  LootRecord,
  CurrencyRecord,
  FactionRecord,
  ExperimentDimension,
  ExperimentMetric,
  ExperimentGroup,
  ExperimentBreakdown,
} from "./read/types.js";
