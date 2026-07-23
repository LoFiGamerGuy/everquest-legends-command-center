/**
 * Entity & pet resolver (ARCHITECTURE.md §3 stage 4, ADR-5; docs/DATA_MODEL.md
 * §3; docs/PRIOR_ART.md — rumstil multi-signal pet model + kauffman12
 * user-correctable "Verified Players / Verified Pets").
 *
 * A stateful registry that consumes the typed event stream and maintains, per
 * observed entity: a kind (player/pet/npc/merc/unknown — `unknown` is
 * first-class, never guessed) and, for pets, an evidence-based link to an
 * owner. Every belief carries `evidence_type` + `confidence` (ADR-006 weights);
 * user assertions (1.0) outrank heuristics and persist. The registry is
 * serializable (`toSnapshot`/`fromSnapshot`) so the DB layer can persist it —
 * this module has NO dependency on `@eqlcc/database`.
 *
 * ── Evidence signals (type → weight → trigger → effect) ──────────────────────
 *  pet_chatter (0.95)  "<Pet> told you, '… Master.'"           pet -> owner("you"); kind=pet
 *  damage_shield_possessive (0.7)  "<mob> is burned by <Pet>'s flames" — bearer
 *      pet-shaped/known-pet AND target is the mob (NOT you)     pet -> owner("you"); kind=pet
 *  name_pattern (0.4)  name matches the EQ pet-name generator   kind=pet HINT ONLY — no owner link
 *  user_assertion (1.0)  setEntityKind / setPetOwner            overrides + persists; always wins
 *
 * ── damage_shield direction + qualification guards (deliberate) ──────────────
 * A possessive DS names the shield BEARER, not necessarily a pet. The bearer is
 * the log owner's pet ONLY when BOTH hold: (a) the burned TARGET is the mob the
 * pet tanks — NOT the log owner: "YOU are burned by <X>'s flames" means you HIT
 * <X>, so <X> is an ENEMY, classified npc, never linked; and (b) the bearer is
 * already known to be a pet or matches the generated-pet-name pattern — an
 * unqualified proper name (a named NPC or another player) casting a DS is not
 * your pet. Both guards prevent booking enemy/other-player DS damage onto the
 * owner's parse (`YOUR` flames = the owner's own shield: attribute to you, no
 * link).
 *
 * ── name_pattern policy (deliberate, documented) ─────────────────────────────
 * A generated-pet-name match tells you a name is pet-SHAPED — i.e. that it is
 * *a* pet — but NOT *whose* pet. So name_pattern is used ONLY as a kind hint
 * (kind=pet at 0.4) and NEVER, on its own, creates a pet -> owner link or rolls
 * damage up to an owner. Ownership requires a signal that actually identifies an
 * owner: pet_chatter / damage_shield_possessive (both tie to the log owner,
 * "you") or an explicit user_assertion. This is why `attributeSource` on a
 * name_pattern-only pet returns the pet itself (no roll-up), never a guessed
 * owner. Rationale: the 0.4 weight is below the attribution threshold precisely
 * so a weak name shape can never masquerade as a fact (ARCHITECTURE.md §1 pt 5).
 */

import type { DamageShieldEvent, EntityKind, EvidenceType, LogEvent, PetChatterEvent } from "@eqlcc/event-schema";
import { EVIDENCE_CONFIDENCE } from "@eqlcc/event-schema";

import { looksLikeGeneratedPetName } from "./pet-name.js";
import type {
  Attribution,
  ClassificationSource,
  ConflictRecord,
  EntityRecord,
  EvidenceRow,
  OwnerIdentity,
  ResolvedEntity,
  ResolverSnapshot,
  SignalMeta,
} from "./types.js";

/** Heuristic evidence types that legitimately identify an owner (excludes name_pattern). */
export type LinkingEvidenceType = "pet_chatter" | "damage_shield_possessive";

/**
 * A pet -> owner link at or above this confidence rolls its contribution up to
 * the owner in `attributeSource`. Set above `name_pattern` (0.4) and at/below
 * `damage_shield_possessive` (0.7): a bare name shape never attributes; observed
 * combat / chatter evidence does. Downstream always also gets the confidence.
 */
export const ATTRIBUTION_MIN_CONFIDENCE = 0.5;

/** Kind confidence for the logging character (the `You` referent — certain). */
const OWNER_KIND_CONFIDENCE = 1.0;
/** Kind confidence for article-led NPC names (grammar convention, LOG_FORMAT_SPEC §3). */
const NPC_KIND_CONFIDENCE = 0.9;

/** Constructor options: who owns this log (the referent of You/YOU/your/YOUR). */
export interface EntityResolverOptions {
  owner?: Partial<OwnerIdentity>;
}

export class EntityResolver {
  private readonly ownerIdentity: OwnerIdentity;
  private readonly ownerCanonical: string;
  private readonly entities = new Map<string, EntityRecord>();

  constructor(options: EntityResolverOptions = {}) {
    const o = options.owner ?? {};
    this.ownerIdentity = {
      character: o.character ?? null,
      server: o.server ?? null,
      logFileId: o.logFileId ?? null,
    };
    this.ownerCanonical = this.ownerIdentity.character ?? "you";
    this.ensureOwnerEntity();
  }

  /** Build a resolver from an `eqlog_<Character>_<server>.txt` file name. */
  static forLogFile(fileName: string, logFileId?: number): EntityResolver {
    const parsed = parseLogFileName(fileName);
    return new EntityResolver({
      owner: {
        character: parsed?.character ?? null,
        server: parsed?.server ?? null,
        ...(logFileId === undefined ? {} : { logFileId }),
      },
    });
  }

  /** The resolved owner identity (the referent of You/YOU/your/YOUR). */
  get owner(): Readonly<OwnerIdentity> {
    return this.ownerIdentity;
  }

  // ── Ingestion ──────────────────────────────────────────────────────────────

  /**
   * Feed one typed event. Registers every named participant (applying the
   * name_pattern kind hint) and routes pet_chatter / damage_shield to their
   * evidence handlers. Non-participant events are ignored. Deterministic and
   * side-effect-free beyond the registry.
   */
  observe(event: LogEvent): void {
    const meta: SignalMeta = { ts: event.ts, seq: event.seq, source: event.raw };
    switch (event.type) {
      case "pet_chatter":
        this.observePetChatter(event, meta);
        return;
      case "damage_shield":
        this.observeDamageShield(event, meta);
        return;
      case "melee_hit":
      case "spell_damage":
        this.registerEntity(event.attacker, meta);
        this.registerEntity(event.target, meta);
        return;
      case "melee_miss":
        this.registerEntity(event.attacker, meta);
        this.registerEntity(event.target, meta);
        return;
      case "dot_tick":
        if (event.attacker !== null) this.registerEntity(event.attacker, meta);
        this.registerEntity(event.target, meta);
        return;
      case "heal":
        this.registerEntity(event.healer, meta);
        this.registerEntity(event.target, meta);
        return;
      case "kill":
        this.registerEntity(event.killer, meta);
        this.registerEntity(event.target, meta);
        return;
      case "death":
        this.registerEntity(event.entity, meta);
        if (event.killer !== null) this.registerEntity(event.killer, meta);
        return;
      default:
        return;
    }
  }

  /**
   * pet_chatter (0.95) — the strongest in-log signal for EQL: a bare-named
   * entity telling *you* "… Master." is your pet. Links pet -> owner("you") and
   * classifies the pet. The unwrapped form (`pet: null`) names no pet, so it
   * yields no link (explicit, never guessed).
   */
  observePetChatter(event: PetChatterEvent, meta: SignalMeta = {}): void {
    if (event.pet === null) return;
    const petRec = this.registerEntity(event.pet, meta);
    this.applyKind(petRec, "pet", "heuristic", EVIDENCE_CONFIDENCE.pet_chatter, "pet_chatter", meta);
    this.recordOwnerEvidence(petRec, this.ownerCanonical, "pet_chatter", EVIDENCE_CONFIDENCE.pet_chatter, meta, false);
  }

  /**
   * damage_shield_possessive (0.7) — "X is burned by <Owner>'s flames".
   *
   * The possessive names the shield-bearer. `YOUR` is the logging character's
   * own shield (attributes to you; no pet link). A bare *proper-name* bearer in
   * the character's own log is treated as the character's pet -> owner("you")
   * (a documented, user-correctable heuristic: observed combat evidence, hence
   * stronger than a bare name shape). An article-led NPC possessive ("a Nisch
   * Mal Gnoll's frost") is guarded OUT — it is classified npc and forms NO pet
   * link (the false-positive class an earlier review caught).
   */
  observeDamageShield(event: DamageShieldEvent, meta: SignalMeta = {}): void {
    this.registerEntity(event.target, meta);

    // `YOUR flames` — the logging character's own shield (any owner-cased token,
    // not just the literal "YOUR", so we are not coupled to recognizer casing).
    if (this.isOwnerToken(event.owner)) {
      this.ensureOwnerEntity();
      return;
    }

    const bearer = this.registerEntity(event.owner, meta);

    // Direction guard: "X is burned by <bearer>'s flames" attributes to <bearer>
    // ONLY when <bearer> is the shield-bearer being *attacked* (the mob's shield
    // burns whoever hits it). When the burned target is the log owner —
    // "YOU are burned by <bearer>'s flames" — the bearer is an ENEMY you hit,
    // never your pet. Classify it as an NPC and form NO pet link / no roll-up.
    if (this.canonicalId(event.target) === this.ownerCanonical) {
      this.applyKind(bearer, "npc", "heuristic", NPC_KIND_CONFIDENCE, undefined, meta);
      return;
    }

    // Qualification guard: a possessive shield bearer counts as a pet only when
    // it is ALREADY known to be a pet (e.g. via pet_chatter) or its name matches
    // the generated-pet-name pattern. An unqualified proper name (a named NPC or
    // another player) casting a DS is NOT the log owner's pet — no link.
    const bearerIsPetCandidate = bearer.kind === "pet" || looksLikeGeneratedPetName(bearer.canonical);
    if (isArticleNpcName(event.owner)) {
      this.applyKind(bearer, "npc", "heuristic", NPC_KIND_CONFIDENCE, undefined, meta);
      return;
    }
    if (!bearerIsPetCandidate) return;

    // Genuine pet damage-shield burning the mob it tanks -> pet -> owner("you").
    this.applyKind(
      bearer,
      "pet",
      "heuristic",
      EVIDENCE_CONFIDENCE.damage_shield_possessive,
      "damage_shield_possessive",
      meta,
    );
    this.recordOwnerEvidence(
      bearer,
      this.ownerCanonical,
      "damage_shield_possessive",
      EVIDENCE_CONFIDENCE.damage_shield_possessive,
      meta,
      false,
    );
  }

  /**
   * Record a heuristic pet -> owner signal with an EXPLICIT owner. This is the
   * general primitive the in-log handlers use (pet_chatter / damage_shield both
   * call it with owner = the log owner). Exposed so the pipeline can replay
   * persisted signals or supply a group-aware owner, and so conflict resolution
   * is first-class. Confidence is the ADR-006 weight of `evidenceType`.
   * `name_pattern` is intentionally NOT accepted (it never identifies an owner —
   * see the class docstring); use setPetOwner for a locking user correction.
   */
  recordOwnerSignal(
    pet: string,
    owner: string,
    evidenceType: LinkingEvidenceType,
    meta: SignalMeta = {},
  ): void {
    // Register the owner so a link never dangles (entity_links.owner_entity_id ->
    // entities(id) FK integrity for the DB layer, DATA_MODEL.md §3).
    const ownerRec = this.registerEntity(owner, meta);
    const petRec = this.registerEntity(pet, meta);
    this.applyKind(petRec, "pet", "heuristic", EVIDENCE_CONFIDENCE[evidenceType], evidenceType, meta);
    this.recordOwnerEvidence(petRec, ownerRec.canonical, evidenceType, EVIDENCE_CONFIDENCE[evidenceType], meta, false);
  }

  // ── User corrections (kauffman12 "Verified Players / Verified Pets") ─────────

  /**
   * Explicit user classification. Writes user_assertion (1.0) evidence that
   * overrides heuristics and persists across snapshots (ADR-5).
   */
  setEntityKind(name: string, kind: EntityKind, opts: { asserted: true }): EntityRecord {
    void opts;
    const rec = this.registerEntity(name);
    this.applyKind(rec, kind, "user", EVIDENCE_CONFIDENCE.user_assertion, "user_assertion", {
      source: "user assertion",
    });
    // Reclassifying to a non-pet kind must stop stale roll-ups: deactivate the
    // owner link (kept for audit, never rolled up while inactive). Re-asserting
    // pet re-activates any existing link.
    if (rec.ownerLink !== undefined) {
      rec.ownerLink.active = kind === "pet";
    }
    return rec;
  }

  /**
   * Explicit user pet -> owner correction. Writes user_assertion (1.0) evidence
   * that overrides any heuristic link and persists. An entity given an owner is
   * by definition a pet, so its kind is set to pet as well.
   */
  setPetOwner(pet: string, owner: string, opts: { asserted: true }): EntityRecord {
    void opts;
    const ownerRec = this.registerEntity(owner);
    if (ownerRec.kind === "unknown") {
      this.applyKind(ownerRec, "player", "user", EVIDENCE_CONFIDENCE.user_assertion, undefined, {
        source: "user assertion (owner)",
      });
    }
    const petRec = this.registerEntity(pet);
    this.applyKind(petRec, "pet", "user", EVIDENCE_CONFIDENCE.user_assertion, "user_assertion", {
      source: "user assertion",
    });
    this.recordOwnerEvidence(
      petRec,
      this.canonicalId(owner),
      "user_assertion",
      EVIDENCE_CONFIDENCE.user_assertion,
      { source: "user assertion" },
      true,
    );
    return petRec;
  }

  // ── Query API ────────────────────────────────────────────────────────────────

  /** Resolve a name to its canonical entity, kind, owner (if any), and evidence. */
  resolve(name: string): ResolvedEntity {
    const canonical = this.canonicalId(name);
    const rec = this.entities.get(canonical);
    if (rec === undefined) {
      return { canonical, kind: "unknown", confidence: 0, evidence: [] };
    }
    const evidence = [...rec.kindEvidence, ...(rec.ownerLink?.evidence ?? [])];
    // Only surface an owner when the entity is currently a pet AND the link is
    // active. A user reclassification to a non-pet kind (which also deactivates
    // the link) never exposes a pet-owner fact; the evidence stays for audit.
    const activeLink =
      rec.kind === "pet" && rec.ownerLink !== undefined && rec.ownerLink.active ? rec.ownerLink : undefined;
    return {
      canonical: rec.canonical,
      kind: rec.kind,
      ...(activeLink === undefined ? {} : { ownerId: activeLink.ownerId }),
      confidence: rec.kindConfidence,
      evidence,
    };
  }

  /**
   * The entity a combat event's contribution should be booked to for stats. A
   * pet rolls up to its owner via `attributedId` ONLY when the actor is currently
   * classified `pet` AND holds an ACTIVE link at/above ATTRIBUTION_MIN_CONFIDENCE;
   * otherwise the acting entity owns its own contribution. So a user
   * reclassifying a pet to player/npc (which deactivates the link) immediately
   * stops the roll-up — a stale heuristic link can never keep booking damage on
   * the owner. `confidence` is ALWAYS returned so downstream never treats a guess
   * as fact. Events with no in-log source (environmental / unknown-source DoT)
   * attribute to an explicit `unknown`.
   *
   * This is a pure query: it does NOT mutate the registry (unseen names are
   * classified transiently, never inserted — ingestion happens only via observe).
   */
  attributeSource(event: LogEvent): Attribution {
    const name = sourceNameOf(event);
    if (name === null) {
      return {
        sourceId: "unknown",
        attributedId: "unknown",
        kind: "unknown",
        rolledUp: false,
        confidence: 0,
        evidence: [],
      };
    }
    const rec = this.lookupOrClassify(name);
    const link = rec.ownerLink;
    const rollsUp =
      rec.kind === "pet" &&
      link !== undefined &&
      link.active &&
      link.confidence >= ATTRIBUTION_MIN_CONFIDENCE &&
      link.ownerId !== rec.canonical;
    if (rollsUp && link !== undefined) {
      return {
        sourceId: rec.canonical,
        attributedId: link.ownerId,
        kind: rec.kind,
        ownerId: link.ownerId,
        rolledUp: true,
        confidence: link.confidence,
        evidence: link.evidence,
      };
    }
    return {
      sourceId: rec.canonical,
      attributedId: rec.canonical,
      kind: rec.kind,
      rolledUp: false,
      confidence: rec.kindConfidence,
      evidence: rec.kindEvidence,
    };
  }

  /** Look up a stored record by name (canonicalized). */
  get(name: string): EntityRecord | undefined {
    return this.entities.get(this.canonicalId(name));
  }

  /** All tracked entity records (snapshot-independent copy). */
  list(): EntityRecord[] {
    return [...this.entities.values()].map(cloneEntity);
  }

  // ── Persistence ──────────────────────────────────────────────────────────────

  /** Serializable snapshot (DB layer persists this; ADR-5). */
  toSnapshot(): ResolverSnapshot {
    return {
      version: 1,
      owner: { ...this.ownerIdentity },
      entities: this.list(),
    };
  }

  /** Restore a resolver from a snapshot; classifications, assertions, and evidence survive exactly. */
  static fromSnapshot(snapshot: ResolverSnapshot): EntityResolver {
    const resolver = new EntityResolver({ owner: snapshot.owner });
    for (const rec of snapshot.entities) {
      resolver.entities.set(rec.canonical, cloneEntity(rec));
    }
    // The owner entity is restored from the snapshot above (or re-ensured here).
    resolver.ensureOwnerEntity();
    return resolver;
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private ensureOwnerEntity(): EntityRecord {
    const existing = this.entities.get(this.ownerCanonical);
    if (existing !== undefined) return existing;
    const rec: EntityRecord = {
      canonical: this.ownerCanonical,
      displayName: this.ownerIdentity.character ?? "You",
      kind: "player",
      classificationSource: "system",
      kindConfidence: OWNER_KIND_CONFIDENCE,
      kindEvidence: [],
    };
    this.entities.set(this.ownerCanonical, rec);
    return rec;
  }

  /** Map any name (You/YOU/your/YOUR/character-name → owner) to a canonical id. */
  private canonicalId(name: string): string {
    const trimmed = name.trim();
    return this.isOwnerToken(trimmed) ? this.ownerCanonical : trimmed;
  }

  private isOwnerToken(name: string): boolean {
    const lower = name.toLowerCase();
    if (lower === "you" || lower === "your") return true;
    const character = this.ownerIdentity.character;
    return character !== null && lower === character.toLowerCase();
  }

  /**
   * Read-only lookup for the query path: return the stored record, or a
   * transient classification for an unseen name WITHOUT inserting it. Keeps
   * `attributeSource`/`resolve` free of the ingestion side effects of
   * `registerEntity` (the ingestion-vs-query boundary the class draws).
   */
  private lookupOrClassify(name: string): EntityRecord {
    const canonical = this.canonicalId(name);
    return this.entities.get(canonical) ?? this.classifyNew(canonical, name, {});
  }

  /** Register (or touch) an entity, applying first-seen kind classification. */
  private registerEntity(name: string, meta: SignalMeta = {}): EntityRecord {
    const canonical = this.canonicalId(name);
    const existing = this.entities.get(canonical);
    if (existing !== undefined) {
      if (meta.ts !== undefined) {
        existing.lastSeenTs = meta.ts;
        existing.firstSeenTs ??= meta.ts;
      }
      return existing;
    }
    const rec = this.classifyNew(canonical, name, meta);
    this.entities.set(canonical, rec);
    return rec;
  }

  private classifyNew(canonical: string, displayName: string, meta: SignalMeta): EntityRecord {
    const base: EntityRecord = {
      canonical,
      displayName,
      kind: "unknown",
      classificationSource: "heuristic",
      kindConfidence: 0,
      kindEvidence: [],
      ...(meta.ts === undefined ? {} : { firstSeenTs: meta.ts, lastSeenTs: meta.ts }),
    };
    if (canonical === this.ownerCanonical) {
      base.kind = "player";
      base.classificationSource = "system";
      base.kindConfidence = OWNER_KIND_CONFIDENCE;
      base.displayName = this.ownerIdentity.character ?? "You";
    } else if (isArticleNpcName(displayName)) {
      // Grammar convention: article-led names are NPCs (LOG_FORMAT_SPEC §3).
      base.kind = "npc";
      base.kindConfidence = NPC_KIND_CONFIDENCE;
    } else if (looksLikeGeneratedPetName(displayName)) {
      // name_pattern: KIND hint only — pet-shaped, but owner stays unknown.
      base.kind = "pet";
      base.kindConfidence = EVIDENCE_CONFIDENCE.name_pattern;
      base.kindEvidence.push(evidenceRow("name_pattern", EVIDENCE_CONFIDENCE.name_pattern, meta));
    }
    // else: bare name we will not guess — kind stays `unknown` (first-class).
    return base;
  }

  /**
   * Set/upgrade an entity's kind. Max-confidence-wins, except a user
   * classification always wins and is never overridden by a later heuristic.
   * The evidence row (when given) is always appended for the audit trail.
   */
  private applyKind(
    rec: EntityRecord,
    kind: EntityKind,
    source: ClassificationSource,
    confidence: number,
    evidenceType: EvidenceType | undefined,
    meta: SignalMeta,
  ): void {
    if (evidenceType !== undefined) {
      rec.kindEvidence.push(evidenceRow(evidenceType, confidence, meta));
    }
    const isUser = source === "user";
    if (rec.classificationSource === "user" && !isUser) return; // never downgrade a user call
    if (isUser || confidence > rec.kindConfidence) {
      rec.kind = kind;
      rec.classificationSource = source;
      rec.kindConfidence = confidence;
    }
  }

  /**
   * Record a pet -> owner signal and recompute the best link. Conflicts (a
   * signal naming a different owner) resolve by confidence: higher wins; equal
   * keeps the first and records the conflict. A user assertion always wins and
   * locks the link (`asserted`) so heuristics never override it.
   */
  private recordOwnerEvidence(
    rec: EntityRecord,
    ownerId: string,
    evidenceType: EvidenceType,
    confidence: number,
    meta: SignalMeta,
    asserted: boolean,
  ): void {
    // Guarantee the owner entity exists so the link never dangles (FK integrity).
    if (!this.entities.has(ownerId)) this.registerEntity(ownerId);
    const row = evidenceRow(evidenceType, confidence, meta);

    // A user assertion that the candidate is NOT a pet suppresses heuristic
    // ownership entirely: a later pet_chatter/DS signal must not create or revive
    // an owner link (or resolve() would surface a pet-owner fact the user denied).
    // The signal is still retained for audit — in kindEvidence (pushed by
    // applyKind before this call) and, when a prior link exists, in its evidence.
    if (!asserted && rec.classificationSource === "user" && rec.kind !== "pet") {
      if (rec.ownerLink !== undefined) {
        rec.ownerLink.evidence.push(row);
        rec.ownerLink.active = false;
      }
      return;
    }

    const link = rec.ownerLink;
    if (link === undefined) {
      rec.ownerLink = {
        ownerId,
        evidenceType,
        confidence,
        asserted,
        active: true,
        evidence: [row],
        conflicts: [],
      };
      return;
    }
    // A fresh signal re-activates a link the user had deactivated only if it is a
    // user assertion (an entity re-asserted as a pet); heuristics never revive it.
    if (asserted) link.active = true;
    link.evidence.push(row);

    let becomesBest: boolean;
    if (asserted) {
      becomesBest = true; // user assertion always wins (a later assertion, too)
    } else if (link.asserted) {
      becomesBest = false; // never override a locked user assertion with a heuristic
    } else {
      becomesBest = confidence > link.confidence;
    }
    const ownerChanged = ownerId !== link.ownerId;

    if (becomesBest) {
      if (ownerChanged) {
        link.conflicts.push(conflict(link.ownerId, link.evidenceType, link.confidence, link.confidence < confidence ? "lower_confidence" : "equal_confidence_kept_first", meta.ts));
      }
      link.ownerId = ownerId;
      link.evidenceType = evidenceType;
      link.confidence = confidence;
      if (asserted) link.asserted = true;
    } else if (ownerChanged) {
      link.conflicts.push(conflict(ownerId, evidenceType, confidence, confidence < link.confidence ? "lower_confidence" : "equal_confidence_kept_first", meta.ts));
    }
  }
}

// ── Free helpers ───────────────────────────────────────────────────────────────

/** Parsed `eqlog_<Character>_<server>.txt` file name. */
export function parseLogFileName(fileName: string): { character: string; server: string } | null {
  const base = fileName.replace(/^.*[/\\]/, "");
  const m = /^eqlog_([^_]+)_([^.]+)\.txt$/i.exec(base);
  if (m === null) return null;
  return { character: m[1] as string, server: m[2] as string };
}

/** Article-led names are NPCs by EQL grammar convention (LOG_FORMAT_SPEC §3). */
function isArticleNpcName(name: string): boolean {
  return /^(?:a|an|the)\s/i.test(name.trim());
}

function evidenceRow(evidenceType: EvidenceType, confidence: number, meta: SignalMeta): EvidenceRow {
  return {
    evidenceType,
    confidence,
    ...(meta.ts === undefined ? {} : { ts: meta.ts }),
    ...(meta.seq === undefined ? {} : { seq: meta.seq }),
    ...(meta.source === undefined ? {} : { source: meta.source }),
  };
}

function conflict(
  ownerId: string,
  evidenceType: EvidenceType,
  confidence: number,
  reason: ConflictRecord["reason"],
  ts: number | undefined,
): ConflictRecord {
  return {
    ownerId,
    evidenceType,
    confidence,
    reason,
    ...(ts === undefined ? {} : { ts }),
  };
}

/** Which field names the acting entity of a contribution, per event type. */
function sourceNameOf(event: LogEvent): string | null {
  switch (event.type) {
    case "melee_hit":
    case "melee_miss":
    case "spell_damage":
      return event.attacker;
    case "dot_tick":
      return event.attacker; // null = unknown source, handled by caller
    case "damage_shield":
      return event.owner; // "YOUR" canonicalizes to the log owner
    case "self_damage":
    case "rune_absorb":
      return "You";
    case "heal":
      return event.healer;
    case "kill":
      return event.killer;
    default:
      return null;
  }
}

/** Deep-ish copy of an entity record (arrays/objects cloned; primitives copied). */
function cloneEntity(rec: EntityRecord): EntityRecord {
  return {
    ...rec,
    kindEvidence: rec.kindEvidence.map((r) => ({ ...r })),
    ...(rec.ownerLink === undefined
      ? {}
      : {
          ownerLink: {
            ...rec.ownerLink,
            evidence: rec.ownerLink.evidence.map((r) => ({ ...r })),
            conflicts: rec.ownerLink.conflicts.map((c) => ({ ...c })),
          },
        }),
  };
}
