/**
 * Environmental/untyped damage (§4.6), corpus-discovered self damage, and
 * rune absorption (§4.8).
 */

import type { RecognizerRule } from "../rule.js";
import { regexRule } from "../rule.js";

export const miscDamageRules: RecognizerRule[] = [
  // Corpus-discovered: "You hurt yourself for 5 points." (9.3k lines — spell
  // recourse / blood costs). Sourceless wording by design.
  regexRule({
    ruleId: "self-damage",
    family: "self_damage",
    frequencyRank: 120,
    regex: /^You hurt yourself for (?<amount>\d+) points?\.$/,
    build: (g) => ({
      type: "self_damage",
      amount: Number.parseInt(g["amount"] as string, 10),
    }),
  }),

  // "You were hit by non-melee for 4 damage." — sourceless (§4.6); the line
  // names no source, so `attacker` is explicit null (never guessed).
  regexRule({
    ruleId: "environmental-damage",
    family: "environmental_damage",
    frequencyRank: 630,
    regex: /^You were hit by non-melee for (?<amount>\d+) damage\.$/,
    build: (g) => ({
      type: "environmental_damage",
      amount: Number.parseInt(g["amount"] as string, 10),
      attacker: null,
    }),
  }),

  // "You gain a rune for 12 points of absorption." (§4.8 — spec-verified;
  // absent from the July benchmark corpus, fixture taken from the spec's
  // captured example.)
  regexRule({
    ruleId: "rune-absorb",
    family: "rune_absorb",
    frequencyRank: 640,
    regex: /^You gain a rune for (?<amount>\d+) points of absorption\.$/,
    build: (g) => ({
      type: "rune_absorb",
      amount: Number.parseInt(g["amount"] as string, 10),
    }),
  }),
];
