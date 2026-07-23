/**
 * @eqlcc/event-schema — typed append-only event model for EQL Command Center.
 * Pure types + constants; zero runtime dependencies (ARCHITECTURE.md §2).
 */

export {
  DIALECT_EQL_BETA_2026_07,
  ENTITY_KINDS,
  EVIDENCE_TYPES,
  EVIDENCE_CONFIDENCE,
} from "./enums.js";
export type { DialectId, EntityKind, EvidenceType } from "./enums.js";

export { EVENT_TYPES, EVENT_TYPE_STATUS } from "./events.js";
export type {
  EventBase,
  MeleeHitEvent,
  MeleeMissEvent,
  SpellDamageEvent,
  DotTickEvent,
  DamageShieldEvent,
  EnvironmentalDamageEvent,
  HealEvent,
  RuneAbsorbEvent,
  KillEvent,
  DeathEvent,
  XpGainEvent,
  LevelUpEvent,
  AbilityPurchaseEvent,
  SkillUpEvent,
  LootItemEvent,
  LootAutoSellEvent,
  ZoneEnterEvent,
  StanceChangeBeginEvent,
  StanceChangeEvent,
  InvocationChangeBeginEvent,
  InvocationChangeEvent,
  CastBeginEvent,
  CastResumeEvent,
  CastInterruptEvent,
  SpellResistEvent,
  FactionChangeEvent,
  PetChatterEvent,
  ChatMessageEvent,
  LogToggleEvent,
  RawUnknownEvent,
  LogEvent,
  EventType,
  EventTypeStatus,
  EventOfType,
} from "./events.js";

export { isEventType, assertNever } from "./guards.js";
