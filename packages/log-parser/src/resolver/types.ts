/**
 * Resolver data model (docs/DATA_MODEL.md §3 "Entities and the
 * evidence/confidence pattern", ARCHITECTURE.md ADR-5).
 *
 * These are the in-memory / serializable shapes the {@link EntityResolver}
 * maintains. They deliberately mirror the `entities` / `entity_links` /
 * `entity_overrides` tables so the database layer can persist a snapshot
 * without translation — but this module has ZERO dependency on `@eqlcc/database`
 * (ARCHITECTURE.md §2 dependency rules): the resolver only defines the shape
 * and its (de)serialization.
 */

import type { EntityKind, EvidenceType } from "@eqlcc/event-schema";

/** How a kind classification was decided (DATA_MODEL.md `entities.classification_source`). */
export type ClassificationSource = "heuristic" | "user" | "system";

/** Provenance threaded from a source event onto an evidence row. */
export interface SignalMeta {
  /** Event timestamp (unix ms). */
  ts?: number;
  /** Per-file emission ordinal of the source event. */
  seq?: number;
  /** Verbatim raw line (or short note) justifying the signal. */
  source?: string;
}

/**
 * One observed signal, kept as an audit trail so an attribution is NEVER a
 * silent guess — every belief records why we hold it (DATA_MODEL.md §3).
 */
export interface EvidenceRow {
  evidenceType: EvidenceType;
  /** ADR-006 weight of this signal (0–1). */
  confidence: number;
  /** Event timestamp (unix ms) when observed, when the signal came from an event. */
  ts?: number;
  /** Per-file emission ordinal of the source event, when applicable. */
  seq?: number;
  /** Verbatim raw line (or a short note) that justified the signal. */
  source?: string;
}

/**
 * Best pet -> owner attribution plus the full audit trail of every signal seen
 * (DATA_MODEL.md `entity_links`: "multiple rows per pet allowed; the resolver
 * surfaces the best active link").
 */
export interface OwnerLink {
  /** Canonical id of the owning entity. */
  ownerId: string;
  /** Evidence type of the current BEST (highest-confidence) signal. */
  evidenceType: EvidenceType;
  /** Confidence of the current best signal. */
  confidence: number;
  /** True once a user assertion set this link; heuristics never override it. */
  asserted: boolean;
  /** Every signal ever recorded for this pet, in observation order. */
  evidence: EvidenceRow[];
  /** Signals that disagreed with the surviving best link (kept for transparency). */
  conflicts: ConflictRecord[];
}

/** A recorded disagreement between two owner signals (DATA_MODEL.md §3). */
export interface ConflictRecord {
  /** The owner the rejected signal argued for. */
  ownerId: string;
  evidenceType: EvidenceType;
  confidence: number;
  /** Why the signal did not become the best link. */
  reason: "lower_confidence" | "equal_confidence_kept_first";
  ts?: number;
}

/**
 * One tracked entity (DATA_MODEL.md `entities`) plus its pet->owner link and
 * the evidence behind both its kind and its ownership.
 */
export interface EntityRecord {
  /** Stable canonical id/name (registry key). */
  canonical: string;
  /** Name as first observed (for display). */
  displayName: string;
  kind: EntityKind;
  classificationSource: ClassificationSource;
  /** Confidence of the current kind classification (0–1). */
  kindConfidence: number;
  /** Audit trail for the kind classification (name_pattern / pet_chatter / …). */
  kindEvidence: EvidenceRow[];
  /** Best pet -> owner link, when one has been established. */
  ownerLink?: OwnerLink;
  firstSeenTs?: number;
  lastSeenTs?: number;
}

/**
 * Serializable registry snapshot. The DB layer persists this; a reload via
 * {@link EntityResolver.fromSnapshot} restores classifications, user
 * assertions, and evidence exactly (ADR-5 "persistent, correctable lists").
 */
export interface ResolverSnapshot {
  /** Snapshot schema version (bump on shape change). */
  version: 1;
  owner: OwnerIdentity;
  entities: EntityRecord[];
}

/** The log's owner character — the referent of "You"/"YOU"/"your"/"YOUR". */
export interface OwnerIdentity {
  /** Character name from `eqlog_<Character>_<server>.txt`, or null if unknown. */
  character: string | null;
  server: string | null;
  /** Source `log_files.id`, when known. */
  logFileId: number | null;
}

/** {@link EntityResolver.resolve} result. */
export interface ResolvedEntity {
  canonical: string;
  kind: EntityKind;
  /** Present only when a pet -> owner link exists. */
  ownerId?: string;
  /** Confidence of the kind classification (0–1). */
  confidence: number;
  /** Combined kind + ownership evidence, so a caller never treats a guess as fact. */
  evidence: EvidenceRow[];
}

/**
 * {@link EntityResolver.attributeSource} result: the entity a combat event's
 * contribution should be booked to for stats. Pets roll up to their owner via
 * `attributedId`; `confidence` is ALWAYS returned so downstream never mistakes
 * a heuristic for a fact.
 */
export interface Attribution {
  /** The raw acting entity named in the event (before roll-up). */
  sourceId: string;
  /** Who the contribution is booked to (owner when linked, else the actor). */
  attributedId: string;
  kind: EntityKind;
  /** Set when the contribution rolled up from a pet to an owner. */
  ownerId?: string;
  /** True when `attributedId` differs from `sourceId` (a pet roll-up happened). */
  rolledUp: boolean;
  /** Confidence in the attribution (owner-link confidence when rolled up). */
  confidence: number;
  evidence: EvidenceRow[];
}
