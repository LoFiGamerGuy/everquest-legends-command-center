import { describe, expect, it } from "vitest";

import { DIALECT_EQL_BETA_2026_07 } from "@eqlcc/event-schema";

import { LogParser, RecognizerRegistry, allRules, regexRule } from "../src/index.js";
import type { RecognizerRule } from "../src/index.js";

describe("RecognizerRegistry", () => {
  it("orders rules most-frequent-first with unique ids and ranks (ADR-2)", () => {
    const registry = new RecognizerRegistry();
    const ranks = registry.manifest.map((rule) => rule.frequencyRank);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(new Set(registry.manifest.map((r) => r.ruleId)).size).toBe(registry.manifest.length);
    // Corpus-measured head of the manifest: melee first.
    expect(registry.manifest[0]?.ruleId).toBe("melee-hit-third");
    expect(registry.manifest.every((r) => r.dialectId === DIALECT_EQL_BETA_2026_07)).toBe(true);
  });

  it("first match wins (own-cast interrupt beats possessive form)", () => {
    const registry = new RecognizerRegistry();
    // "Your Kilan's Animation spell fizzles!" must be YOUR spell "Kilan's Animation".
    const result = registry.recognize("Your Kilan's Animation spell fizzles!");
    expect(result?.rule.ruleId).toBe("cast-fizzle-you");
    expect(result?.payload).toMatchObject({ caster: "You", spell: "Kilan's Animation" });
  });

  it("encodes the death-you before kill-other order constraint", () => {
    const registry = new RecognizerRegistry();
    expect(registry.recognize("You have been slain by an ogre guard!")?.rule.ruleId).toBe(
      "death-you",
    );
    expect(registry.recognize("An armadillo has been slain by Playerfive!")?.rule.ruleId).toBe(
      "kill-other",
    );
  });

  it("splits the pet-chatter vs NPC-tell boundary on the '… Master.' suffix", () => {
    const registry = new RecognizerRegistry();
    // Pet report tells (incl. multi-token warder senders) -> pet_chatter.
    expect(
      registry.recognize("Petone told you, 'Attacking a dune spiderling Master.'")?.rule.ruleId,
    ).toBe("pet-chatter");
    expect(
      registry.recognize("Playerfour`s warder told you, 'Attacking a forest drakeling Master.'"),
    ).toMatchObject({ rule: { ruleId: "pet-chatter" }, payload: { pet: "Playerfour`s warder" } });
    expect(
      registry.recognize("Petone told you, 'I am unable to wake a hardened skeleton, Master.'")
        ?.rule.ruleId,
    ).toBe("pet-chatter");
    // Merchant/banker tells (no Master suffix) -> chat_message, never 0.95 pet evidence.
    expect(
      registry.recognize("Dougina told you, 'That'll be 0 money for the Package for Old Doug.'"),
    ).toMatchObject({ rule: { ruleId: "chat-tell-npc" }, payload: { type: "chat_message", channel: "tell" } });
    expect(registry.recognize("Doug Jr told you, 'Welcome to my bank!'")?.rule.ruleId).toBe(
      "chat-tell-npc",
    );
  });

  it("returns null for unknown lines", () => {
    const registry = new RecognizerRegistry();
    expect(registry.recognize("A line format nobody has ever captured.")).toBeNull();
  });

  it("disables a throwing rule for the session instead of aborting (§7)", () => {
    const bomb: RecognizerRule = {
      ruleId: "test-bomb",
      family: "test",
      frequencyRank: 1,
      dialectId: DIALECT_EQL_BETA_2026_07,
      match() {
        throw new Error("boom");
      },
    };
    const ok = regexRule({
      ruleId: "test-ok",
      family: "test",
      frequencyRank: 2,
      regex: /^hello$/,
      build: () => ({ type: "system_message", kind: "test" }),
    });
    const registry = new RecognizerRegistry([bomb, ok]);
    expect(registry.recognize("hello")?.rule.ruleId).toBe("test-ok");
    expect(registry.ruleErrors.get("test-bomb")).toBe("boom");
    // Still recognizes afterwards; the bomb stays disabled.
    expect(registry.recognize("hello")?.rule.ruleId).toBe("test-ok");
  });

  it("rejects unanchored regex rules at construction", () => {
    expect(() =>
      regexRule({
        ruleId: "bad",
        family: "test",
        frequencyRank: 3,
        regex: /loose/,
        build: () => ({ type: "system_message", kind: "x" }),
      }),
    ).toThrow(/anchored/);
  });

  it("rejects duplicate ruleIds and frequencyRanks", () => {
    const a = allRules();
    expect(() => new RecognizerRegistry([...a, a[0] as RecognizerRule])).toThrow(/duplicate/);
  });
});

describe("LogParser error paths", () => {
  it("emits raw_unknown with carried-forward ts on malformed timestamps", () => {
    const parser = new LogParser({ logFileId: 3 });
    const good = parser.parseLine({
      raw: "[Fri Jul 10 17:14:01 2026] Auto attack is on.",
      byteOffset: 0,
      lineNo: 1,
    });
    expect(good.type).toBe("system_message");
    const bad = parser.parseLine({ raw: "corrupted garbage line", byteOffset: 47, lineNo: 2 });
    expect(bad).toMatchObject({
      type: "raw_unknown",
      ruleId: null,
      ts: Date.UTC(2026, 6, 10, 17, 14, 1),
      byteOffset: 47,
      lineNo: 2,
      logFileId: 3,
    });
  });
});
