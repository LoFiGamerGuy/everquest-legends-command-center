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
export const coinGain = (
  totalCopper: number,
  source: "corpse" | "item" | "merchant" = "corpse",
): EventFields => ({ type: "coin_gain", totalCopper, source });
export const skillUp = (skill: string, value: number): EventFields => ({
  type: "skill_up",
  skill,
  value,
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
  s.add(SECOND, coinGain(5, "corpse")); // +5c loot_coin (verified coin_gain), session 2
  s.add(SECOND, skillUp("1H Slashing", 12)); // skill_events row (verified skill_up), session 2
  return s;
}

/** Small deterministic PRNG (mulberry32) so synthetic corpora are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A large deterministic synthetic combat log (~`target` events) with a realistic
 * combat / encounter / heal / xp / zone mix plus the rare stance/invocation/
 * level_up types that used to drive the superlinear rebuild hotspot (E1.3 /
 * issue #21). Fabricated (never a real log). Deterministic in `seed`, so the perf
 * guard and the equivalence checks over it are reproducible.
 */
export function syntheticCombatScenario(target: number, seed = 1): Scenario {
  const s = new Scenario();
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const allies = ["You", "Grimbek", "Aelwyn", "Petone", "Thornax"] as const;
  const zones = ["The Northern Desert of Ro", "New Sebilis Expedition", "Befallen", "Guk"] as const;
  const mobs = ["a dune spiderling", "a greater skeleton", "a sand golem", "an armadillo"] as const;
  const stances = ["berserker", "defensive", "precision"] as const;
  const invocations = ["recovery", "onslaught", "focus"] as const;
  let level = 50;

  s.add(0, zoneEnter(zones[0]));
  s.add(SECOND, stance(stances[0]));
  s.add(SECOND, invocation(invocations[0]));
  while (s.events.length < target) {
    const r = rnd();
    if (r < 0.01) {
      s.add(SECOND, zoneEnter(pick(zones)));
    } else if (r < 0.03) {
      s.add(SECOND, stance(pick(stances)));
    } else if (r < 0.05) {
      s.add(SECOND, invocation(pick(invocations)));
    } else {
      // A combat burst against a single mob → one encounter.
      const mob = pick(mobs);
      const bursts = 6 + Math.floor(rnd() * 20);
      for (let i = 0; i < bursts && s.events.length < target; i++) {
        const atk = pick(allies);
        const k = rnd();
        if (k < 0.5) s.add(400, melee(atk, mob, 10 + Math.floor(rnd() * 200)));
        else if (k < 0.6) s.add(400, meleeMiss(atk, mob));
        else if (k < 0.78) s.add(400, spell(atk, mob, 20 + Math.floor(rnd() * 300)));
        else if (k < 0.86) s.add(400, dot(atk, mob, 15 + Math.floor(rnd() * 100)));
        else if (k < 0.93) s.add(400, heal(atk, pick(allies), 30 + Math.floor(rnd() * 200), 250));
        else s.add(400, damageShield(atk, mob, 5 + Math.floor(rnd() * 30)));
      }
      if (s.events.length < target) s.add(500, kill(allies[0], mob));
      if (s.events.length < target && rnd() < 0.9) s.add(300, xpGain(500 + Math.floor(rnd() * 2000)));
      if (s.events.length < target && rnd() < 0.15) s.add(300, levelUp((level += 1)));
      if (s.events.length < target && rnd() < 0.3) s.add(300, lootAutoSell("Husk", mob, 10 + Math.floor(rnd() * 50)));
      if (s.events.length < target && rnd() < 0.2) s.add(300, coinGain(5 + Math.floor(rnd() * 40)));
      if (s.events.length < target && rnd() < 0.1) s.add(300, faction("New Sebilisian Expedition", 100));
      if (s.events.length < target && rnd() < 0.08) s.add(300, skillUp("1H Slashing", 12));
    }
  }
  s.events.length = Math.min(s.events.length, target);
  return s;
}
