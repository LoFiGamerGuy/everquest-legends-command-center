import { describe, expect, it } from "vitest";

import {
  DIALECT_EQL_BETA_2026_07,
  ENTITY_KINDS,
  EVENT_TYPES,
  EVENT_TYPE_STATUS,
  EVIDENCE_CONFIDENCE,
  EVIDENCE_TYPES,
  assertNever,
  isEventType,
} from "../src/index.js";
import type { EventBase, EventOfType, EventType, LogEvent } from "../src/index.js";

// ── Compile-time checks ───────────────────────────────────────────────────────

// EVENT_TYPES must contain every union discriminant (extras/typos are already
// rejected by the `satisfies` clause in events.ts). If a member is missing,
// `MissingFromEventTypes` is not `never` and this assignment fails to compile.
type MissingFromEventTypes = Exclude<EventType, (typeof EVENT_TYPES)[number]>;
const eventTypesComplete: MissingFromEventTypes extends never ? true : never = true;

// ── Sample construction: one event per type ───────────────────────────────────

/** Fixed fake provenance for samples. Raw lines are the spec's own anonymized
 * VERIFIED examples (LOG_FORMAT_SPEC.md §4); reserved types have no verified
 * line and use an empty raw. */
function base(lineNo: number, raw: string): Omit<EventBase, "ruleId"> & { ruleId: string } {
  return {
    ts: 1752900000000 + lineNo * 1000,
    raw,
    byteOffset: lineNo * 100,
    lineNo,
    logFileId: 1,
    dialectId: DIALECT_EQL_BETA_2026_07,
    ruleId: `rule-${lineNo}`,
  };
}

const samples: { [K in EventType]: EventOfType<K> } = {
  melee_hit: {
    ...base(1, "[Wed Jul 16 20:15:01 2026] You pierce a rambunctious pet for 5 points of damage."),
    type: "melee_hit",
    attacker: "You",
    target: "a rambunctious pet",
    verb: "pierce",
    amount: 5,
    modifiers: [],
  },
  melee_miss: {
    ...base(2, "[Wed Jul 16 20:15:02 2026] A wan ghoul knight tries to hit YOU, but misses! (Riposte)"),
    type: "melee_miss",
    attacker: "A wan ghoul knight",
    target: "YOU",
    verb: "hit",
    outcome: "miss",
    annotation: "Riposte",
  },
  spell_damage: {
    ...base(3, "[Wed Jul 16 20:15:03 2026] You hit a dune spiderling for 3 points of fire damage by Burst of Flame."),
    type: "spell_damage",
    attacker: "You",
    target: "a dune spiderling",
    amount: 3,
    school: "fire",
    spell: "Burst of Flame",
    modifiers: [],
  },
  dot_tick: {
    ...base(4, "[Wed Jul 16 20:15:04 2026] A wan ghoul knight has taken 44 damage from your Blood Siphon Strike."),
    type: "dot_tick",
    target: "A wan ghoul knight",
    amount: 44,
    spell: "Blood Siphon Strike",
    attacker: "You",
  },
  damage_shield: {
    ...base(5, "[Wed Jul 16 20:15:05 2026] A greater skeleton is burned by Pettwo's flames for 11 points of non-melee damage."),
    type: "damage_shield",
    target: "A greater skeleton",
    owner: "Pettwo",
    amount: 11,
  },
  environmental_damage: {
    ...base(6, "[Wed Jul 16 20:15:06 2026] You were hit by non-melee for 4 damage."),
    type: "environmental_damage",
    amount: 4,
    attacker: null,
  },
  self_damage: {
    ...base(31, "[Wed Jul 16 20:15:31 2026] You hurt yourself for 5 points."),
    type: "self_damage",
    amount: 5,
  },
  heal: {
    ...base(7, "[Wed Jul 16 20:15:07 2026] You healed Playertwo for 141 (399) hit points by Greater Healing."),
    type: "heal",
    healer: "You",
    target: "Playertwo",
    amount: 141,
    uncappedAmount: 399,
    spell: "Greater Healing",
  },
  rune_absorb: {
    ...base(8, "[Wed Jul 16 20:15:08 2026] You gain a rune for 12 points of absorption."),
    type: "rune_absorb",
    amount: 12,
  },
  kill: {
    ...base(9, "[Wed Jul 16 20:15:09 2026] A fragile pet has been slain by Petone!"),
    type: "kill",
    killer: "Petone",
    target: "A fragile pet",
  },
  death: {
    ...base(10, "[Wed Jul 16 20:15:10 2026] Playerthree died."),
    type: "death",
    entity: "Playerthree",
    killer: null,
  },
  xp_gain: {
    ...base(11, "[Wed Jul 16 20:15:11 2026] You gain experience! (1.019%)"),
    type: "xp_gain",
    percentMilli: 1019,
  },
  level_up: {
    ...base(12, "[Wed Jul 16 20:15:12 2026] You have gained a level! Welcome to level 2!"),
    type: "level_up",
    level: 2,
  },
  ability_purchase: {
    ...base(13, '[Wed Jul 16 20:15:13 2026] You have gained the ability "Origin" at a cost of 0 ability points.'),
    type: "ability_purchase",
    ability: "Origin",
    costPoints: 0,
  },
  loot_item: {
    ...base(14, "[Wed Jul 16 20:15:14 2026] --You have looted a Fragile Pet's Skull from a fragile pet's corpse.--"),
    type: "loot_item",
    item: "Fragile Pet's Skull",
    corpse: "a fragile pet",
    quantity: 1,
  },
  loot_auto_sell: {
    ...base(15, "[Wed Jul 16 20:15:15 2026] You looted 2 Armadillo Husk from an armadillo's corpse and sold it for 1 silver and 8 copper."),
    type: "loot_auto_sell",
    item: "Armadillo Husk",
    corpse: "an armadillo",
    quantity: 2,
    totalCopper: 18,
  },
  coin_gain: {
    ...base(32, "[Wed Jul 16 20:15:32 2026] You receive 1 silver and 8 copper from the corpse."),
    type: "coin_gain",
    totalCopper: 18,
    source: "corpse",
  },
  zone_enter: {
    ...base(16, "[Wed Jul 16 20:15:16 2026] You have entered The Northern Desert of Ro."),
    type: "zone_enter",
    zone: "The Northern Desert of Ro",
  },
  stance_change_begin: {
    ...base(17, "[Wed Jul 16 20:15:17 2026] You begin to change your stance."),
    type: "stance_change_begin",
  },
  stance_change: {
    ...base(18, "[Wed Jul 16 20:15:18 2026] You assume a berserker stance."),
    type: "stance_change",
    stance: "berserker",
  },
  invocation_change_begin: {
    ...base(19, "[Wed Jul 16 20:15:19 2026] You begin to change your invocation."),
    type: "invocation_change_begin",
  },
  invocation_change: {
    ...base(20, "[Wed Jul 16 20:15:20 2026] You begin reciting the recovery invocation."),
    type: "invocation_change",
    invocation: "recovery",
  },
  cast_begin: {
    ...base(21, "[Wed Jul 16 20:15:21 2026] You begin casting Cavorting Bones."),
    type: "cast_begin",
    caster: "You",
    spell: "Cavorting Bones",
  },
  cast_resume: {
    ...base(22, "[Wed Jul 16 20:15:22 2026] You regain your concentration and continue your casting."),
    type: "cast_resume",
  },
  cast_interrupt: {
    ...base(23, "[Wed Jul 16 20:15:23 2026] Your Light Healing spell is interrupted."),
    type: "cast_interrupt",
    caster: "You",
    spell: "Light Healing",
    reason: "interrupted",
  },
  faction_change: {
    ...base(24, "[Wed Jul 16 20:15:24 2026] Your faction standing with New Sebilisian Expedition has been adjusted by 100."),
    type: "faction_change",
    faction: "New Sebilisian Expedition",
    delta: 100,
  },
  skill_up: {
    ...base(25, "[Wed Jul 16 20:15:25 2026] You have become better at Meditate! (2)"),
    type: "skill_up",
    skill: "Meditate",
    value: 2,
  },
  pet_chatter: {
    ...base(26, "[Wed Jul 16 20:15:26 2026] Petone told you, 'Attacking a dune spiderling Master.'"),
    type: "pet_chatter",
    pet: "Petone",
    message: "Attacking a dune spiderling Master.",
    petTarget: "a dune spiderling",
  },
  chat_message: {
    ...base(27, "[Wed Jul 16 20:15:27 2026] Playerfive tells General:2, '...'"),
    type: "chat_message",
    speaker: "Playerfive",
    channel: "General",
    channelNumber: 2,
    message: "...",
  },
  spell_emote: {
    ...base(33, "[Wed Jul 16 20:15:33 2026] A greater skeleton staggers."),
    type: "spell_emote",
    subject: "A greater skeleton",
    emote: "staggers.",
  },
  system_message: {
    ...base(34, "[Wed Jul 16 20:15:34 2026] Auto attack is on."),
    type: "system_message",
    kind: "auto_attack_on",
  },
  log_toggle: {
    ...base(28, "[Wed Jul 16 20:15:28 2026] Logging to 'eqlog.txt' is now *ON*."),
    type: "log_toggle",
    file: "eqlog.txt",
    state: "ON",
  },
  spell_resist: {
    ...base(29, "[Wed Jul 16 20:15:29 2026] You resist a large plague rat's Plague Rat Disease!"),
    type: "spell_resist",
    caster: "a large plague rat",
    target: "You",
    spell: "Plague Rat Disease",
  },
  raw_unknown: {
    ts: 1752900030000,
    raw: "[Wed Jul 16 20:15:30 2026] Soandso invoked some line format we have never seen.",
    byteOffset: 3000,
    lineNo: 30,
    logFileId: 1,
    dialectId: DIALECT_EQL_BETA_2026_07,
    ruleId: null,
    type: "raw_unknown",
  },
};

const allSamples: LogEvent[] = Object.values(samples);

/** Exhaustive switch over every union member; `assertNever` in `default`
 * makes this a COMPILE error if a type is ever unhandled. */
function familyOf(event: LogEvent): string {
  switch (event.type) {
    case "melee_hit":
    case "melee_miss":
    case "spell_damage":
    case "dot_tick":
    case "damage_shield":
    case "environmental_damage":
    case "self_damage":
      return "damage";
    case "heal":
    case "rune_absorb":
      return "defense";
    case "kill":
    case "death":
      return "death";
    case "xp_gain":
    case "level_up":
    case "ability_purchase":
    case "skill_up":
      return "progression";
    case "loot_item":
    case "loot_auto_sell":
    case "coin_gain":
      return "loot";
    case "zone_enter":
      return "world";
    case "stance_change_begin":
    case "stance_change":
    case "invocation_change_begin":
    case "invocation_change":
    case "cast_begin":
    case "cast_resume":
    case "cast_interrupt":
    case "spell_resist":
      return "casting";
    case "faction_change":
      return "faction";
    case "pet_chatter":
    case "chat_message":
      return "chat";
    case "spell_emote":
      return "emote";
    case "system_message":
      return "system";
    case "log_toggle":
      return "meta";
    case "raw_unknown":
      return "unknown";
    default:
      return assertNever(event);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("event type enum", () => {
  it("has the 30 types of LOG_FORMAT_SPEC.md §5 plus 4 corpus-discovered families", () => {
    expect(eventTypesComplete).toBe(true);
    expect(EVENT_TYPES).toHaveLength(34);
    expect(new Set(EVENT_TYPES).size).toBe(34);
  });

  it("constructs one event of every type, each carrying full provenance", () => {
    expect(Object.keys(samples).sort()).toEqual([...EVENT_TYPES].sort());
    for (const event of allSamples) {
      expect(EVENT_TYPES).toContain(event.type);
      expect(typeof event.ts).toBe("number");
      expect(typeof event.raw).toBe("string");
      expect(typeof event.byteOffset).toBe("number");
      expect(typeof event.lineNo).toBe("number");
      expect(typeof event.logFileId).toBe("number");
      expect(event.dialectId).toBe(DIALECT_EQL_BETA_2026_07);
    }
  });

  it("classifies every type through an exhaustive switch", () => {
    for (const event of allSamples) {
      expect(typeof familyOf(event)).toBe("string");
    }
    expect(familyOf(samples.melee_hit)).toBe("damage");
    expect(familyOf(samples.raw_unknown)).toBe("unknown");
  });

  it("has no reserved types left: cast_interrupt, skill_up, spell_resist verified by corpus fixtures", () => {
    const reserved = EVENT_TYPES.filter((t) => EVENT_TYPE_STATUS[t] === "reserved").sort();
    expect(reserved).toEqual([]);
    expect(EVENT_TYPE_STATUS.raw_unknown).toBe("always");
    expect(EVENT_TYPES.filter((t) => EVENT_TYPE_STATUS[t] === "verified")).toHaveLength(33);
  });

  it("raw_unknown has ruleId null; recognized events carry a rule id", () => {
    expect(samples.raw_unknown.ruleId).toBeNull();
    for (const event of allSamples) {
      if (event.type !== "raw_unknown") expect(typeof event.ruleId).toBe("string");
    }
  });
});

describe("type guards", () => {
  it("isEventType narrows to the matching payload", () => {
    const event: LogEvent = samples.melee_hit;
    expect(isEventType(event, "melee_hit")).toBe(true);
    if (isEventType(event, "melee_hit")) {
      // Narrowed: payload fields are visible without casts.
      expect(event.attacker).toBe("You");
      expect(event.amount).toBe(5);
      expect(event.modifiers).toEqual([]);
    }
    expect(isEventType(event, "heal")).toBe(false);
  });

  it("assertNever throws when reached at runtime", () => {
    expect(() => assertNever("bogus" as never)).toThrow(/bogus/);
  });
});

describe("shared enums and evidence weights", () => {
  it("exposes the DATA_MODEL entity kinds", () => {
    expect([...ENTITY_KINDS]).toEqual(["player", "pet", "npc", "merc", "unknown"]);
  });

  it("carries the ADR-006 default confidence weights, one per evidence type", () => {
    expect(EVIDENCE_CONFIDENCE).toEqual({
      pet_chatter: 0.95,
      damage_shield_possessive: 0.7,
      name_pattern: 0.4,
      user_assertion: 1.0,
    });
    expect(Object.keys(EVIDENCE_CONFIDENCE).sort()).toEqual([...EVIDENCE_TYPES].sort());
  });

  it("user_assertion outranks every heuristic", () => {
    for (const evidence of EVIDENCE_TYPES) {
      expect(EVIDENCE_CONFIDENCE.user_assertion).toBeGreaterThanOrEqual(
        EVIDENCE_CONFIDENCE[evidence],
      );
    }
  });

  it("stores domain integers losslessly (milli-percent, copper)", () => {
    expect(samples.xp_gain.percentMilli).toBe(1019); // '1.019%' -> 1019
    expect(Number.isInteger(samples.xp_gain.percentMilli)).toBe(true);
    expect(samples.loot_auto_sell.totalCopper).toBe(18); // '1 silver and 8 copper'
    expect(Number.isInteger(samples.loot_auto_sell.totalCopper)).toBe(true);
  });
});
