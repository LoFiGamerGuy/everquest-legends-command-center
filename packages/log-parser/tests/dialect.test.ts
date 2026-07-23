/**
 * Dialect model + extends/override mechanism (LAUNCH_DIALECT_READINESS.md §1).
 *
 * All derived-dialect rules here are SYNTHETIC (obviously-fake wording like
 * "SYNTHHIT ..."); no launch format is authored (never-fabricate rule). The
 * point is to prove the registry's reuse/override machinery, not any real
 * launch line.
 */

import { describe, expect, it } from "vitest";

import { DIALECT_EQL_BETA_2026_07 } from "@eqlcc/event-schema";

import {
  DialectRegistry,
  LogParser,
  createDefaultDialectRegistry,
  RecognizerRegistry,
  allRules,
  regexRule,
} from "../src/index.js";
import type { RecognizerRule } from "../src/index.js";

const SYNTH_DIALECT = "eql-synthetic-derived-test";

/** A synthetic rule overriding beta's `melee-hit-third` (same id + rank). */
function overrideRule(frequencyRank: number): RecognizerRule {
  return regexRule({
    ruleId: "melee-hit-third",
    family: "melee_hit",
    frequencyRank,
    dialectId: SYNTH_DIALECT,
    regex: /^SYNTHHIT (?<n>\d+)$/,
    build: () => ({ type: "system_message", kind: "synth-melee" }),
  });
}

/** A synthetic brand-new rule (new id + unused rank). */
function addedRule(): RecognizerRule {
  return regexRule({
    ruleId: "synth-added-rule",
    family: "synth_added",
    frequencyRank: 100000,
    dialectId: SYNTH_DIALECT,
    regex: /^SYNTHNEW (?<x>\w+)$/,
    build: () => ({ type: "system_message", kind: "synth-added" }),
  });
}

describe("DialectRegistry extends/override (§1)", () => {
  it("reuses base rules and applies override-by-id + add-by-id", () => {
    const registry = new DialectRegistry();
    const beta = registry.register({ id: DIALECT_EQL_BETA_2026_07, rules: allRules() });
    const baseRank = beta.rules.find((r) => r.ruleId === "melee-hit-third")?.frequencyRank ?? 0;

    const derived = registry.register({
      id: SYNTH_DIALECT,
      extends: DIALECT_EQL_BETA_2026_07,
      rules: [overrideRule(baseRank), addedRule()],
    });

    // One override replaces in place; one add grows the set by exactly one.
    expect(derived.rules.length).toBe(beta.rules.length + 1);

    // The overriding rule (same id) is the derived one, not beta's.
    const derivedMelee = derived.rules.find((r) => r.ruleId === "melee-hit-third");
    expect(derivedMelee?.dialectId).toBe(SYNTH_DIALECT);

    const recognizer = registry.recognizerFor(SYNTH_DIALECT);
    // New wording matches under the derived dialect...
    expect(recognizer?.recognize("SYNTHHIT 42")?.rule.ruleId).toBe("melee-hit-third");
    // ...the old beta melee wording no longer matches the overridden rule.
    const old = recognizer?.recognize("A coyote bites YOU for 1 point of damage.");
    expect(old?.rule.ruleId).not.toBe("melee-hit-third");
    // The brand-new rule is live.
    expect(recognizer?.recognize("SYNTHNEW token")?.rule.ruleId).toBe("synth-added-rule");
    // A reused, untouched base rule still works (proves inheritance).
    expect(recognizer?.recognize("Auto attack is on.")).not.toBeNull();
  });

  it("leaves the base dialect completely unchanged when a derived one is added", () => {
    const registry = new DialectRegistry();
    const beta = registry.register({ id: DIALECT_EQL_BETA_2026_07, rules: allRules() });
    const beforeCount = beta.rules.length;
    const baseRank = beta.rules.find((r) => r.ruleId === "melee-hit-third")?.frequencyRank ?? 0;

    registry.register({
      id: SYNTH_DIALECT,
      extends: DIALECT_EQL_BETA_2026_07,
      rules: [overrideRule(baseRank), addedRule()],
    });

    const betaAfter = registry.get(DIALECT_EQL_BETA_2026_07);
    expect(betaAfter?.rules.length).toBe(beforeCount);
    // Beta still parses the original melee wording with the original rule.
    expect(
      registry.recognizerFor(DIALECT_EQL_BETA_2026_07)?.recognize(
        "A coyote bites YOU for 1 point of damage.",
      )?.rule.ruleId,
    ).toBe("melee-hit-third");
  });

  it("rejects duplicate registration, unknown base, and clashing ranks", () => {
    const registry = new DialectRegistry();
    registry.register({ id: DIALECT_EQL_BETA_2026_07, rules: allRules() });
    expect(() => registry.register({ id: DIALECT_EQL_BETA_2026_07, rules: [] })).toThrow(
      /already registered/,
    );
    expect(() =>
      registry.register({ id: "x", extends: "no-such-dialect", rules: [] }),
    ).toThrow(/unregistered/);
    // Added rule collides with an existing beta frequencyRank -> registry throws.
    expect(() =>
      registry.register({
        id: "y",
        extends: DIALECT_EQL_BETA_2026_07,
        rules: [
          regexRule({
            ruleId: "synth-clash",
            family: "synth",
            frequencyRank: 10, // melee-hit-third's rank — occupied.
            regex: /^SYNTHCLASH$/,
            build: () => ({ type: "system_message", kind: "x" }),
          }),
        ],
      }),
    ).toThrow(/duplicate frequencyRank/);
  });

  it("rejects a duplicate ruleId WITHIN one declaration (not silently de-duped)", () => {
    const registry = new DialectRegistry();
    registry.register({ id: DIALECT_EQL_BETA_2026_07, rules: allRules() });
    expect(() =>
      registry.register({
        id: "z",
        extends: DIALECT_EQL_BETA_2026_07,
        rules: [
          regexRule({
            ruleId: "synth-dup",
            family: "synth",
            frequencyRank: 100001,
            regex: /^SYNTHDUPA$/,
            build: () => ({ type: "system_message", kind: "a" }),
          }),
          regexRule({
            ruleId: "synth-dup", // same id twice in one declaration
            family: "synth",
            frequencyRank: 100002,
            regex: /^SYNTHDUPB$/,
            build: () => ({ type: "system_message", kind: "b" }),
          }),
        ],
      }),
    ).toThrow(/duplicate ruleId in declaration/);
  });

  it("stamps declaration rules to the dialect id; reused base rules keep theirs", () => {
    const registry = new DialectRegistry();
    registry.register({ id: DIALECT_EQL_BETA_2026_07, rules: allRules() });
    // A declaration rule that OMITS dialectId defaults to beta at construction...
    const omitted = regexRule({
      ruleId: "synth-omit",
      family: "synth",
      frequencyRank: 100003,
      regex: /^SYNTHOMIT$/,
      build: () => ({ type: "system_message", kind: "o" }),
    });
    expect(omitted.dialectId).toBe(DIALECT_EQL_BETA_2026_07);

    const derived = registry.register({
      id: SYNTH_DIALECT,
      extends: DIALECT_EQL_BETA_2026_07,
      rules: [omitted],
    });
    // ...but is stamped to the derived dialect so its events carry correct provenance.
    expect(derived.rules.find((r) => r.ruleId === "synth-omit")?.dialectId).toBe(SYNTH_DIALECT);
    // A reused, unchanged base rule keeps beta (its wording is truly beta's).
    expect(derived.rules.find((r) => r.ruleId === "melee-hit-third")?.dialectId).toBe(
      DIALECT_EQL_BETA_2026_07,
    );
  });
});

describe("LogParser dialect tagging of fallthrough events (per-dialect diagnostics)", () => {
  const unrecognized = "[Fri Jul 10 17:14:01 2026] totally unrecognized launch body xyz";

  it("stamps raw_unknown and malformed-timestamp events with the parser's dialectId", () => {
    const parser = new LogParser({ logFileId: 1, dialectId: "eql-launch-test" });
    const unknown = parser.parseLine({ raw: unrecognized, byteOffset: 0, lineNo: 1 });
    expect(unknown.type).toBe("raw_unknown");
    expect(unknown.dialectId).toBe("eql-launch-test");
    const malformed = parser.parseLine({ raw: "garbage no timestamp", byteOffset: 60, lineNo: 2 });
    expect(malformed.type).toBe("raw_unknown");
    expect(malformed.dialectId).toBe("eql-launch-test");
  });

  it("defaults to beta when no dialectId is given (byte-identical to before)", () => {
    const unknown = new LogParser({ logFileId: 1 }).parseLine({
      raw: unrecognized,
      byteOffset: 0,
      lineNo: 1,
    });
    expect(unknown.dialectId).toBe(DIALECT_EQL_BETA_2026_07);
  });
});

describe("createDefaultDialectRegistry (backward compatible, §1/§2.3)", () => {
  it("registers only beta, with its baseline attached", () => {
    const registry = createDefaultDialectRegistry();
    expect(registry.ids()).toEqual([DIALECT_EQL_BETA_2026_07]);
    expect(registry.get(DIALECT_EQL_BETA_2026_07)?.baseline?.dialectId).toBe(
      DIALECT_EQL_BETA_2026_07,
    );
  });

  it("beta's effective rules are byte-identical to the standalone registry", () => {
    const registry = createDefaultDialectRegistry();
    const viaDialect = registry.get(DIALECT_EQL_BETA_2026_07)?.rules ?? [];
    const standalone = new RecognizerRegistry().manifest;
    expect(viaDialect.map((r) => r.ruleId)).toEqual(standalone.map((r) => r.ruleId));
    expect(viaDialect.map((r) => r.frequencyRank)).toEqual(
      standalone.map((r) => r.frequencyRank),
    );
    expect(viaDialect.length).toBe(standalone.length);
  });
});
