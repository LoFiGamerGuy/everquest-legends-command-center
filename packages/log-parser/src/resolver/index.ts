/**
 * Entity & pet resolver (ARCHITECTURE.md §3 stage 4, ADR-5).
 * Public surface: the stateful {@link EntityResolver}, its data-model types,
 * and the generated-pet-name helper.
 */

export { EntityResolver, ATTRIBUTION_MIN_CONFIDENCE, parseLogFileName } from "./entity-resolver.js";
export type { EntityResolverOptions, LinkingEvidenceType } from "./entity-resolver.js";
export { GENERATED_PET_NAME, looksLikeGeneratedPetName } from "./pet-name.js";
export type {
  Attribution,
  ClassificationSource,
  ConflictRecord,
  EntityRecord,
  EvidenceRow,
  OwnerIdentity,
  OwnerLink,
  ResolvedEntity,
  ResolverSnapshot,
  SignalMeta,
} from "./types.js";
