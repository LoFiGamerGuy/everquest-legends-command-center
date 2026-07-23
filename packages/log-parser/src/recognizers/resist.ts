/**
 * Spell resists (spec §5 #29 — now corpus-VERIFIED in four forms).
 *
 *   "You resist a large plague rat's Plague Rat Disease!"       (you resist)
 *   "A lesser mummy resisted your Weakening Strike!"            (your spell resisted)
 *   "A skeleton resisted Playerfive's Disease Cloud!"           (third-party)
 *   "Playerfive tries to cast a spell on you, but you are protected." (no spell named)
 *
 * ORDER CONSTRAINT: `resist-your-spell` before `resist-other` (the possessive
 * regex must not eat "your <spell>").
 */

import type { RecognizerRule } from "../rule.js";
import { regexRule } from "../rule.js";

export const resistRules: RecognizerRule[] = [
  regexRule({
    ruleId: "resist-you",
    family: "spell_resist",
    frequencyRank: 370,
    regex: /^You resist (?<caster>.+?)'s (?<spell>.+?)!$/,
    build: (g) => ({
      type: "spell_resist",
      caster: g["caster"] as string,
      target: "You",
      spell: g["spell"] as string,
    }),
  }),
  regexRule({
    ruleId: "resist-your-spell",
    family: "spell_resist",
    frequencyRank: 380,
    regex: /^(?<target>.+?) resisted your (?<spell>.+?)!$/,
    build: (g) => ({
      type: "spell_resist",
      caster: "You",
      target: g["target"] as string,
      spell: g["spell"] as string,
    }),
  }),
  regexRule({
    ruleId: "resist-other",
    family: "spell_resist",
    frequencyRank: 430,
    regex: /^(?<target>.+?) resisted (?<caster>.+?)'s (?<spell>.+?)!$/,
    build: (g) => ({
      type: "spell_resist",
      caster: g["caster"] as string,
      target: g["target"] as string,
      spell: g["spell"] as string,
    }),
  }),
  // Protection/reflect form — no spell named; fields stay absent, never guessed.
  regexRule({
    ruleId: "resist-protected",
    family: "spell_resist",
    frequencyRank: 320,
    regex: /^(?<caster>.+?) tries to cast a spell on you, but you are protected\.$/,
    build: (g) => ({
      type: "spell_resist",
      caster: g["caster"] as string,
      target: "You",
    }),
  }),
];
