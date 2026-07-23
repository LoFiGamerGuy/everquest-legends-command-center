/**
 * Shared combat interpretation (docs/PROJECTIONS_SPEC.md §5–§6).
 *
 * Pure helpers over a typed event + the live resolver: who is the enemy, who is
 * an ally, and — for rollups — which entity a contribution is credited to (with
 * pet→owner fold via the resolver's `attributeSource`). Kept pure and
 * projector-agnostic so encounters, actor-stats, and buckets each derive the
 * same view independently (a partial single-projector rebuild recomputes it
 * without depending on another projector having run this pass).
 */

import type { LogEvent } from "@eqlcc/event-schema";

import type { PassContext } from "./projectors/types.js";

export type DamageKind = "melee" | "spell" | "dot" | "ds";

/** The combat event types that open/attach encounters (spec §5). */
export function isEncounterTrigger(event: LogEvent): boolean {
  switch (event.type) {
    case "melee_hit":
    case "melee_miss":
    case "spell_damage":
    case "dot_tick":
    case "damage_shield":
    case "kill":
      return true;
    default:
      return false;
  }
}

/** Canonicalize a raw name through the resolver (You/owner → owner id). */
export function canon(ctx: PassContext, name: string): string {
  return ctx.resolver.resolve(name).canonical;
}

type SideClass = "owner" | "enemy" | "unknown";

/** Three-way classification of a combat participant (spec §5). */
function classify(ctx: PassContext, canonical: string): SideClass {
  if (canonical === ctx.ownerId) return "owner";
  const kind = ctx.resolver.resolve(canonical).kind;
  if (kind === "npc") return "enemy";
  if (kind === "player" || kind === "pet" || kind === "merc") return "owner";
  if (/^(?:a|an|the)\s/i.test(canonical)) return "enemy"; // grammar fallback
  return "unknown";
}

/**
 * Is `canonical` the enemy side — an NPC / article-led mob? Owner, players, and
 * pets never are. This is the seam that makes combat group-wide (ADR-4).
 */
export function isEnemyLike(ctx: PassContext, canonical: string): boolean {
  return classify(ctx, canonical) === "enemy";
}

/** The owner's side of a fight: anyone not the enemy (spec §5 group-wide). */
export function isAllySide(ctx: PassContext, canonical: string): boolean {
  return classify(ctx, canonical) !== "enemy";
}

/** The two named combat sides for an enemy-bearing event, canonicalized. */
export interface Sides {
  a: string | null;
  b: string;
}

export function combatSides(ctx: PassContext, event: LogEvent): Sides | null {
  switch (event.type) {
    case "melee_hit":
    case "melee_miss":
    case "spell_damage":
      return { a: canon(ctx, event.attacker), b: canon(ctx, event.target) };
    case "dot_tick":
      return { a: event.attacker === null ? null : canon(ctx, event.attacker), b: canon(ctx, event.target) };
    case "damage_shield":
      return { a: canon(ctx, event.owner), b: canon(ctx, event.target) };
    case "kill":
      return { a: canon(ctx, event.killer), b: canon(ctx, event.target) };
    default:
      return null;
  }
}

export interface EnemyView {
  /** Canonical id of the enemy participant (the encounter's primary target). */
  enemy: string;
  /** Ally participants named in this event (owner side), canonical ids. */
  allies: string[];
  /** True when the enemy is the attacker (dealt), false when it took damage. */
  enemyIsAttacker: boolean;
}

/**
 * Identify the enemy of a combat event: the participant that is not an ally (and
 * not a pet of an ally). Returns null when the event names no enemy on the
 * owner's side (e.g. two NPCs, or an all-ally line) — such lines do not
 * open/attach an encounter (spec §5). `a` is the attacker side, `b` the target.
 */
export function enemyView(ctx: PassContext, event: LogEvent): EnemyView | null {
  const sides = combatSides(ctx, event);
  if (sides === null) return null;
  const { a, b } = sides;
  const ca: SideClass = a === null ? "unknown" : classify(ctx, a);
  const cb: SideClass = classify(ctx, b);

  // The enemy is the non-owner side; when the owner attacks an `unknown` it is
  // the enemy (a named boss), and an `unknown` attacking an `enemy` is an ally.
  let enemyIsA: boolean | null = null;
  if (ca === "owner" && cb !== "owner") enemyIsA = false;
  else if (cb === "owner" && ca !== "owner") enemyIsA = true;
  else if (ca === "enemy" && cb === "unknown") enemyIsA = true;
  else if (cb === "enemy" && ca === "unknown") enemyIsA = false;
  if (enemyIsA === null) return null; // both owner, both enemy, or both unknown

  if (enemyIsA) {
    if (a === null) return null;
    return { enemy: a, allies: [b], enemyIsAttacker: true };
  }
  return { enemy: b, allies: a === null ? [] : [a], enemyIsAttacker: false };
}

/** A contribution credited to an ally actor (spec §6). */
export interface Contribution {
  /** entities.id of the actual acting entity (a pet keeps its own row). */
  actorId: number;
  /** entities.id of the owner when the pet rolled up, else null. */
  attribOwnerId: number | null;
  /** Attribution confidence (owner-link confidence when rolled up, else kind conf). */
  confidence: number;
  damageKind: DamageKind | null;
  /** Capped damage or heal amount (0 for a miss). */
  amount: number;
  /** Uncapped heal amount when present (for overheal), else null. */
  uncapped: number | null;
  isMiss: boolean;
  isHeal: boolean;
}

function damageKindOf(event: LogEvent): DamageKind | null {
  switch (event.type) {
    case "melee_hit":
      return "melee";
    case "spell_damage":
      return "spell";
    case "dot_tick":
      return "dot";
    case "damage_shield":
      return "ds";
    default:
      return null;
  }
}

/**
 * The stat contribution of an event, credited to the attributed ally actor, or
 * null when the event is not an ally contribution. `enemyEntityId` is the
 * CURRENT encounter's `primary_target_entity_id`: the encounter's known enemy is
 * NEVER booked as ally output — a named boss's outgoing damage/heals (which the
 * resolver classifies `unknown`, hence ally-side) must not pollute actor stats
 * (review MAJOR 2). Role therefore comes from the encounter's enemy identity, not
 * resolver kind alone. Uses `attributeSource` for the pet→owner fold and its
 * direction guards (e.g. a damage shield burning the owner never rolls up).
 */
export function analyzeContribution(
  ctx: PassContext,
  event: LogEvent,
  enemyEntityId: number | null,
): Contribution | null {
  const kind = event.type;
  const isMiss = kind === "melee_miss";
  const isHeal = kind === "heal";
  const isDamage = damageKindOf(event) !== null;
  if (!isMiss && !isHeal && !isDamage) return null;

  const attribution = ctx.resolver.attributeSource(event);
  // Only ally contributions are booked into actor stats (we do not stat enemies).
  if (!isAllySide(ctx, attribution.attributedId)) return null;

  const actorId = ctx.entities.idFor(attribution.sourceId);
  // The encounter's known enemy is never an ally actor, even when the resolver
  // left it `unknown` (a named boss). Its damage/heals are dropped here.
  if (enemyEntityId !== null && actorId === enemyEntityId) return null;
  const attribOwnerId =
    attribution.rolledUp && attribution.ownerId !== undefined
      ? ctx.entities.idFor(attribution.ownerId)
      : null;

  let amount = 0;
  let uncapped: number | null = null;
  if (isHeal && event.type === "heal") {
    amount = event.amount;
    uncapped = event.uncappedAmount ?? null;
  } else if (isDamage && "amount" in event) {
    amount = (event as { amount: number }).amount;
  }

  return {
    actorId,
    attribOwnerId,
    confidence: attribution.confidence,
    damageKind: damageKindOf(event),
    amount,
    uncapped,
    isMiss,
    isHeal,
  };
}
