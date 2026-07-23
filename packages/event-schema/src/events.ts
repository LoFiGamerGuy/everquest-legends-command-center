/**
 * The typed, append-only event model (docs/LOG_FORMAT_SPEC.md §4–§5,
 * docs/DATA_MODEL.md §2, ARCHITECTURE.md ADR-3).
 *
 * `LogEvent` is a discriminated union on `type`. Discriminant values are the
 * snake_case strings stored in `events.type` (DATA_MODEL.md §2, e.g.
 * `'melee_hit'`); interface names follow the spec's PascalCase family names.
 *
 * Every event preserves the raw line and its source byte offset, and records
 * the dialect + recognizer rule that produced it, so any parse is traceable to
 * the exact rule and fixture that justified it.
 *
 * Entity references (`attacker`, `target`, `healer`, ...) are plain strings
 * exactly as they appear in the log line; entity resolution happens
 * downstream. Where the log itself gives no source, fields are explicitly
 * `null` ("unknown") — never guessed.
 *
 * Types marked RESERVED are UNVERIFIED in LOG_FORMAT_SPEC.md (no fixture yet).
 * The type exists so downstream schemas are stable, but NO recognizer may emit
 * it until a real fixture lands.
 */

import type { DialectId } from "./enums.js";

/** Fields carried by every event (LOG_FORMAT_SPEC.md §5, DATA_MODEL.md §2). */
export interface EventBase {
  /** Unix epoch milliseconds, derived from the line's local-time asctime stamp. */
  ts: number;
  /** Original line, verbatim, minus the line terminator. */
  raw: string;
  /** Offset of the line's first byte in the source file. */
  byteOffset: number;
  /** 1-based line number within the source file (diagnostics/goldens). */
  lineNo: number;
  /** Source log file id (DATA_MODEL.md `log_files.id`). */
  logFileId: number;
  /** Recognizer dialect that parsed this line, e.g. 'eql-beta-2026-07'. */
  dialectId: DialectId;
  /** Id of the recognizer rule that matched. `null` only for `raw_unknown`. */
  ruleId: string;
}

// ── Combat ────────────────────────────────────────────────────────────────────

/** §4.1 — "You pierce a rambunctious pet for 5 points of damage." */
export interface MeleeHitEvent extends EventBase {
  type: "melee_hit";
  attacker: string;
  target: string;
  /** Closed verb set per dialect (verified so far: pierce, punch). */
  verb: string;
  amount: number;
  /** Verbatim annotations (crits, strikethrough — all UNVERIFIED). Empty when none. */
  modifiers: string[];
}

/** §4.2 — "A dune spiderling tries to bite YOU, but misses!" */
export interface MeleeMissEvent extends EventBase {
  type: "melee_miss";
  attacker: string;
  target: string;
  verb: string;
  /** Normalized outcome: 'miss' | 'riposte' | further verified outcomes. */
  outcome: string;
  /** Verbatim parenthesized annotation, e.g. 'Riposte' on a missed line. */
  annotation?: string;
}

/** §4.3 — "You hit a dune spiderling for 3 points of fire damage by Burst of Flame." */
export interface SpellDamageEvent extends EventBase {
  type: "spell_damage";
  attacker: string;
  target: string;
  amount: number;
  /** Damage school (verified: fire, magic). */
  school: string;
  spell: string;
}

/** §4.4 — "A wan ghoul knight has taken 44 damage from your Blood Siphon Strike." */
export interface DotTickEvent extends EventBase {
  type: "dot_tick";
  target: string;
  amount: number;
  spell: string;
  /** `null` = unknown source (caster died/zoned form) — explicit, never guessed. */
  attacker: string | null;
}

/** §4.5 — "A greater skeleton is burned by Pettwo's flames for 11 points of non-melee damage." */
export interface DamageShieldEvent extends EventBase {
  type: "damage_shield";
  target: string;
  /** Possessive owner — pet/player attribution evidence (`damage_shield_possessive`). */
  owner: string;
  amount: number;
}

/** §4.6 — "You were hit by non-melee for 4 damage." Sourceless by design. */
export interface EnvironmentalDamageEvent extends EventBase {
  type: "environmental_damage";
  amount: number;
  /** Always `null`: the line names no source — explicit unknown, never guessed
   * (same pattern as DotTickEvent's unknown-source form). */
  attacker: null;
}

/** §4.7 — "You healed Playertwo for 141 (399) hit points by Greater Healing." */
export interface HealEvent extends EventBase {
  type: "heal";
  healer: string;
  /** Verbatim; may be reflexive ('itself', 'himself', 'herself'). */
  target: string;
  /** Landed (capped) heal; a 0-point heal is a real line. */
  amount: number;
  /** Parenthesized uncapped value when present; overheal = uncappedAmount - amount. */
  uncappedAmount?: number;
  spell: string;
}

/** §4.8 — "You gain a rune for 12 points of absorption." */
export interface RuneAbsorbEvent extends EventBase {
  type: "rune_absorb";
  amount: number;
}

/** §4.9 — "A fragile pet has been slain by Petone!" / "You have slain a dune spiderling!" */
export interface KillEvent extends EventBase {
  type: "kill";
  killer: string;
  target: string;
}

/** §4.9 — "Playerthree died." Killer unknown by construction. */
export interface DeathEvent extends EventBase {
  type: "death";
  entity: string;
  /** `null` = unknown killer — explicit, never guessed. */
  killer: string | null;
}

// ── Progression ───────────────────────────────────────────────────────────────

/** §4.10 — "You gain experience! (1.019%)" */
export interface XpGainEvent extends EventBase {
  type: "xp_gain";
  /** Lossless integer milli-percent: '1.019%' -> 1019 (DATA_MODEL.md §5/§7). */
  percentMilli: number;
}

/** §4.11 — "You have gained a level! Welcome to level 2!" */
export interface LevelUpEvent extends EventBase {
  type: "level_up";
  level: number;
}

/** §4.12 — "You have gained the ability \"Origin\" at a cost of 0 ability points." */
export interface AbilityPurchaseEvent extends EventBase {
  type: "ability_purchase";
  ability: string;
  costPoints: number;
}

/**
 * §4.22 — RESERVED / UNVERIFIED. No EQL fixture; classic wording MUST NOT be
 * assumed. No recognizer ships until a real line lands. Fields optional until verified.
 */
export interface SkillUpEvent extends EventBase {
  type: "skill_up";
  skill?: string;
  value?: number;
}

// ── Loot & economy ────────────────────────────────────────────────────────────

/** §4.13 — "--You have looted a Fragile Pet's Skull from a fragile pet's corpse.--" */
export interface LootItemEvent extends EventBase {
  type: "loot_item";
  item: string;
  /** e.g. "a fragile pet" (corpse owner as written, minus "'s corpse"). */
  corpse: string;
  /** Stack count; 1 for the a/an article form (digit form UNVERIFIED for this wrapper). */
  quantity: number;
}

/** §4.14 — "You looted 2 Armadillo Husk from an armadillo's corpse and sold it for 1 silver and 8 copper." */
export interface LootAutoSellEvent extends EventBase {
  type: "loot_auto_sell";
  item: string;
  corpse: string;
  quantity: number;
  /** Sale price as integer copper: 1p=1000c, 1g=100c, 1s=10c (DATA_MODEL.md §7). */
  totalCopper: number;
}

// ── World & state ─────────────────────────────────────────────────────────────

/** §4.15 — "You have entered The Northern Desert of Ro." */
export interface ZoneEnterEvent extends EventBase {
  type: "zone_enter";
  /** Exact zone string; instance heuristics ('… Expedition') live downstream. */
  zone: string;
}

/** §4.16 — "You begin to change your stance." */
export interface StanceChangeBeginEvent extends EventBase {
  type: "stance_change_begin";
}

/** §4.16 — "You assume a berserker stance." */
export interface StanceChangeEvent extends EventBase {
  type: "stance_change";
  /** Verified: berserker, channeler. Full list unknown. */
  stance: string;
}

/** §4.16 — "You begin to change your invocation." */
export interface InvocationChangeBeginEvent extends EventBase {
  type: "invocation_change_begin";
}

/**
 * §4.16 — "You begin reciting the recovery invocation."
 * Emitted at the 'begin reciting' line until a completion line is verified.
 */
export interface InvocationChangeEvent extends EventBase {
  type: "invocation_change";
  /** Verified: recovery, spellblade. Full list unknown. */
  invocation: string;
}

/** §4.17 — "You begin casting Cavorting Bones." / "Hoptor Thaggelum begins casting Animate Dead." */
export interface CastBeginEvent extends EventBase {
  type: "cast_begin";
  caster: string;
  spell: string;
}

/** §4.17 — "You regain your concentration and continue your casting." */
export interface CastResumeEvent extends EventBase {
  type: "cast_resume";
}

/**
 * §4.17 — RESERVED / UNVERIFIED. Interrupt/fizzle/out-of-mana wording not yet
 * fixtured; no recognizer until it is. Fields optional until verified.
 */
export interface CastInterruptEvent extends EventBase {
  type: "cast_interrupt";
  caster?: string;
  spell?: string;
}

/**
 * §5 #29 — RESERVED / UNVERIFIED. Resist/partial-resist wording not yet
 * fixtured; no recognizer until it is. Fields optional until verified.
 */
export interface SpellResistEvent extends EventBase {
  type: "spell_resist";
  caster?: string;
  target?: string;
  spell?: string;
}

/** §4.18 — "Your faction standing with New Sebilisian Expedition has been adjusted by 100." */
export interface FactionChangeEvent extends EventBase {
  type: "faction_change";
  faction: string;
  /** Signed; positive verified, negative assumed symmetric (UNVERIFIED). */
  delta: number;
}

// ── Chat & meta ───────────────────────────────────────────────────────────────

/** §4.19 — "Petone told you, 'Attacking a dune spiderling Master.'" — strongest pet->owner evidence. */
export interface PetChatterEvent extends EventBase {
  type: "pet_chatter";
  pet: string;
  /** Full quoted message, verbatim. */
  message: string;
  /** Target from the "Attacking <target> Master." sub-match, when present. */
  petTarget?: string;
}

/** §4.20 — "Playerfive tells General:2, '...'" — numbered chat channels. */
export interface ChatMessageEvent extends EventBase {
  type: "chat_message";
  speaker: string;
  channel: string;
  channelNumber: number;
  message: string;
}

/** §4.21 — "Logging to 'eqlog.txt' is now *ON*." — session boundary hint. */
export interface LogToggleEvent extends EventBase {
  type: "log_toggle";
  file: string;
  /** 'OFF' wording accepted by the rule but UNVERIFIED. */
  state: "ON" | "OFF";
}

/** §4.23 — any line matching no recognizer. Always on; nothing is dropped. */
export interface RawUnknownEvent extends Omit<EventBase, "ruleId"> {
  type: "raw_unknown";
  /** No rule matched, by definition (DATA_MODEL.md: rule_id NULL for raw_unknown). */
  ruleId: null;
}

// ── Union & enum ──────────────────────────────────────────────────────────────

/** The append-only event stream's discriminated union (discriminant: `type`). */
export type LogEvent =
  | MeleeHitEvent
  | MeleeMissEvent
  | SpellDamageEvent
  | DotTickEvent
  | DamageShieldEvent
  | EnvironmentalDamageEvent
  | HealEvent
  | RuneAbsorbEvent
  | KillEvent
  | DeathEvent
  | XpGainEvent
  | LevelUpEvent
  | AbilityPurchaseEvent
  | LootItemEvent
  | LootAutoSellEvent
  | ZoneEnterEvent
  | StanceChangeBeginEvent
  | StanceChangeEvent
  | InvocationChangeBeginEvent
  | InvocationChangeEvent
  | CastBeginEvent
  | CastResumeEvent
  | CastInterruptEvent
  | FactionChangeEvent
  | SkillUpEvent
  | PetChatterEvent
  | ChatMessageEvent
  | LogToggleEvent
  | SpellResistEvent
  | RawUnknownEvent;

/**
 * All 30 event type discriminants, in LOG_FORMAT_SPEC.md §5 table order.
 * `satisfies` guarantees no typo/extra; `EVENT_TYPE_STATUS` (a full Record)
 * guarantees completeness against the union.
 */
export const EVENT_TYPES = [
  "melee_hit",
  "melee_miss",
  "spell_damage",
  "dot_tick",
  "damage_shield",
  "environmental_damage",
  "heal",
  "rune_absorb",
  "kill",
  "death",
  "xp_gain",
  "level_up",
  "ability_purchase",
  "loot_item",
  "loot_auto_sell",
  "zone_enter",
  "stance_change_begin",
  "stance_change",
  "invocation_change_begin",
  "invocation_change",
  "cast_begin",
  "cast_resume",
  "cast_interrupt",
  "faction_change",
  "skill_up",
  "pet_chatter",
  "chat_message",
  "log_toggle",
  "spell_resist",
  "raw_unknown",
] as const satisfies readonly LogEvent["type"][];

export type EventType = LogEvent["type"];

/** Verification status per LOG_FORMAT_SPEC.md §5: V, U (reserved), or always-on. */
export type EventTypeStatus = "verified" | "reserved" | "always";

/**
 * Status of each type (LOG_FORMAT_SPEC.md §5). Being a full `Record<EventType, …>`,
 * this is also the compile-time completeness check for `EVENT_TYPES`.
 */
export const EVENT_TYPE_STATUS: Readonly<Record<EventType, EventTypeStatus>> = Object.freeze({
  melee_hit: "verified",
  melee_miss: "verified",
  spell_damage: "verified",
  dot_tick: "verified",
  damage_shield: "verified",
  environmental_damage: "verified",
  heal: "verified",
  rune_absorb: "verified",
  kill: "verified",
  death: "verified",
  xp_gain: "verified",
  level_up: "verified",
  ability_purchase: "verified",
  loot_item: "verified",
  loot_auto_sell: "verified",
  zone_enter: "verified",
  stance_change_begin: "verified",
  stance_change: "verified",
  invocation_change_begin: "verified",
  invocation_change: "verified",
  cast_begin: "verified",
  cast_resume: "verified",
  cast_interrupt: "reserved",
  faction_change: "verified",
  skill_up: "reserved",
  pet_chatter: "verified",
  chat_message: "verified",
  log_toggle: "verified",
  spell_resist: "reserved",
  raw_unknown: "always",
});

/** The event of the union whose discriminant is `K`. */
export type EventOfType<K extends EventType> = Extract<LogEvent, { type: K }>;
