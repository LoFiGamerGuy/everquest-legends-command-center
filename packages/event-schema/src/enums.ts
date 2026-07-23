/**
 * Shared domain enums and constants (docs/DATA_MODEL.md §3).
 *
 * Entity references in event payloads are plain strings at this layer;
 * name -> entity resolution (and pet -> owner linking) happens downstream in
 * the resolver, which uses these enums.
 */

/** Known dialect ids. The first (and currently only) recognizer dialect. */
export const DIALECT_EQL_BETA_2026_07 = "eql-beta-2026-07";

/**
 * Parser dialect identifier, e.g. `eql-beta-2026-07` (ARCHITECTURE.md §6).
 * Kept as `string` because new dialects appear with game patches.
 */
export type DialectId = string;

/** Entity kind classification (DATA_MODEL.md `entities.kind`). */
export const ENTITY_KINDS = ["player", "pet", "npc", "merc", "unknown"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/**
 * Evidence types for derived attributions (DATA_MODEL.md `entity_links.evidence_type`).
 * Every derived fact carries evidence + confidence — never a silent guess (ADR-006).
 */
export const EVIDENCE_TYPES = [
  /** "Petone told you, 'Attacking ... Master.'" — strongest heuristic. */
  "pet_chatter",
  /** "... is burned by Pettwo's flames ..." — possessive links name -> DS owner. */
  "damage_shield_possessive",
  /** Classic pet-name generator pattern — weak evidence only. */
  "name_pattern",
  /** Explicit user correction; outranks all heuristics. */
  "user_assertion",
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

/**
 * Default heuristic confidence weights per evidence type
 * (ADR-006; DATA_MODEL.md §3 "Default heuristic confidences").
 * `user_assertion` is 1.0 and always outranks heuristics.
 */
export const EVIDENCE_CONFIDENCE: Readonly<Record<EvidenceType, number>> = Object.freeze({
  pet_chatter: 0.95,
  damage_shield_possessive: 0.7,
  name_pattern: 0.4,
  user_assertion: 1.0,
});
