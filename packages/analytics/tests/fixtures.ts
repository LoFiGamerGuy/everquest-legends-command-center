/**
 * Synthetic multi-actor fixtures (docs/PROJECTIONS_SPEC.md §9). NOT real player
 * logs — every line is fabricated to exercise a projector rule. A {@link Scenario}
 * assigns monotonic seq / byte_offset / ts so the event stream has a well-defined
 * `(log_file_id, seq)` order.
 */

import { DIALECT_EQL_BETA_2026_07 } from "@eqlcc/event-schema";
import type { LogEvent } from "@eqlcc/event-schema";

interface BaseAssigned {
  ts: number;
  seq: number;
  byteOffset: number;
  lineNo: number;
  logFileId: number;
  dialectId: string;
  ruleId: string;
  raw: string;
}

/** Per-event fields minus the base the Scenario assigns (distributes over the union). */
type EventFields = LogEvent extends infer T
  ? T extends LogEvent
    ? Omit<T, keyof BaseAssigned> & { raw?: string }
    : never
  : never;

const BASE_TS = 1_760_000_000_000;

export class Scenario {
  readonly events: LogEvent[] = [];
  private seq = 0;
  private byte = 0;
  private ts = BASE_TS;

  constructor(private readonly logFileId = 1) {}

  /** Append an event `dtMs` after the previous one. */
  add(dtMs: number, fields: EventFields): LogEvent {
    this.ts += dtMs;
    this.seq += 1;
    const raw = fields.raw ?? `${fields.type} #${this.seq}`;
    const event = {
      ...fields,
      raw,
      ts: this.ts,
      seq: this.seq,
      byteOffset: this.byte,
      lineNo: this.seq,
      logFileId: this.logFileId,
      dialectId: DIALECT_EQL_BETA_2026_07,
      ruleId: `rule-${fields.type}`,
    } as LogEvent;
    this.byte += raw.length + 1;
    this.events.push(event);
    return event;
  }
}

// ── Typed line helpers (only the fields each event carries) ──────────────────

export const zoneEnter = (zone: string): EventFields => ({ type: "zone_enter", zone });
export const stance = (s: string): EventFields => ({ type: "stance_change", stance: s });
export const invocation = (i: string): EventFields => ({ type: "invocation_change", invocation: i });
export const petChatter = (pet: string, petTarget: string): EventFields => ({
  type: "pet_chatter",
  pet,
  message: `Attacking ${petTarget} Master.`,
  petTarget,
});
export const melee = (attacker: string, target: string, amount: number): EventFields => ({
  type: "melee_hit",
  attacker,
  target,
  verb: "pierce",
  amount,
  modifiers: [],
});
export const meleeMiss = (attacker: string, target: string): EventFields => ({
  type: "melee_miss",
  attacker,
  target,
  verb: "pierce",
  outcome: "miss",
});
export const spell = (attacker: string, target: string, amount: number, spellName = "Burst of Flame"): EventFields => ({
  type: "spell_damage",
  attacker,
  target,
  amount,
  school: "fire",
  spell: spellName,
  modifiers: [],
});
export const dot = (attacker: string | null, target: string, amount: number): EventFields => ({
  type: "dot_tick",
  attacker,
  target,
  amount,
  spell: "Blood Siphon",
});
export const damageShield = (owner: string, target: string, amount: number): EventFields => ({
  type: "damage_shield",
  owner,
  target,
  amount,
  element: "flames",
});
export const heal = (healer: string, target: string, amount: number, uncapped?: number): EventFields => ({
  type: "heal",
  healer,
  target,
  amount,
  ...(uncapped === undefined ? {} : { uncappedAmount: uncapped }),
  spell: "Greater Healing",
});
export const kill = (killer: string, target: string): EventFields => ({ type: "kill", killer, target });
export const xpGain = (percentMilli: number): EventFields => ({ type: "xp_gain", percentMilli });
export const levelUp = (level: number): EventFields => ({ type: "level_up", level });
export const ability = (name: string, cost: number): EventFields => ({
  type: "ability_purchase",
  ability: name,
  costPoints: cost,
});
export const lootItem = (item: string, corpse: string, quantity = 1): EventFields => ({
  type: "loot_item",
  item,
  corpse,
  quantity,
});
export const lootAutoSell = (item: string, corpse: string, totalCopper: number, quantity = 1): EventFields => ({
  type: "loot_auto_sell",
  item,
  corpse,
  quantity,
  totalCopper,
});
export const faction = (name: string, delta: number): EventFields => ({
  type: "faction_change",
  faction: name,
  delta,
});

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/**
 * The headline fixture: a group fight with a pet, a heal, a kill+xp, an
 * auto-sell, a zone change, and an AFK gap that splits the session.
 */
export function groupFightScenario(): Scenario {
  const s = new Scenario();
  s.add(0, zoneEnter("The Northern Desert of Ro"));
  s.add(SECOND, stance("berserker"));
  s.add(SECOND, invocation("recovery"));
  s.add(SECOND, petChatter("Petone", "a dune spiderling")); // Petone → owner link
  s.add(SECOND, melee("You", "a dune spiderling", 5)); // opens encounter (trash)
  s.add(SECOND, spell("You", "a dune spiderling", 8));
  s.add(SECOND, melee("Petone", "a dune spiderling", 4)); // pet damage folds to owner
  s.add(SECOND, meleeMiss("You", "a dune spiderling")); // ally miss → miss_count
  s.add(SECOND, heal("You", "Petone", 20, 25)); // heal 20, overheal 5
  s.add(SECOND, kill("You", "a dune spiderling")); // enemy slain
  s.add(SECOND, xpGain(1019)); // within 5s of kill → attributed
  s.add(SECOND, lootAutoSell("Armadillo Husk", "an armadillo", 18, 2)); // +18c auto_sell
  s.add(SECOND, faction("New Sebilisian Expedition", 100));
  s.add(SECOND, ability("Origin", 0));
  // AFK gap > 30 min closes session 1; the next event opens session 2.
  s.add(40 * MINUTE, zoneEnter("New Sebilis Expedition")); // instance heuristic
  s.add(SECOND, melee("You", "a greater skeleton", 7)); // new encounter in session 2
  s.add(SECOND, kill("You", "a greater skeleton"));
  return s;
}
