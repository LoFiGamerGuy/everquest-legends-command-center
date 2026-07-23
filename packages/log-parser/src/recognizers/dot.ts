/**
 * DoT ticks (LOG_FORMAT_SPEC.md §4.4). Four corpus-verified forms; the
 * `from your` form is checked first per spec.
 *
 * The unknown-source form the spec predicted from classic EQ ("… has taken N
 * damage by <spell>." once the caster died/zoned) is now corpus-VERIFIED
 * ("Playerfive has taken 28 damage by Heat Blood.") -> `attacker: null`,
 * explicit, never guessed.
 */

import type { RecognizerRule } from "../rule.js";
import { regexRule } from "../rule.js";

export const dotRules: RecognizerRule[] = [
  // "A wan ghoul knight has taken 44 damage from your Blood Siphon Strike."
  regexRule({
    ruleId: "dot-your",
    family: "dot_tick",
    frequencyRank: 165,
    regex: /^(?<target>.+?) has taken (?<amount>\d+) damage from your (?<spell>.+?)\.$/,
    build: (g) => ({
      type: "dot_tick",
      target: g["target"] as string,
      amount: Number.parseInt(g["amount"] as string, 10),
      spell: g["spell"] as string,
      attacker: "You",
    }),
  }),

  // "You have taken 3 damage from Plague Rat Disease by a large plague rat."
  regexRule({
    ruleId: "dot-you",
    family: "dot_tick",
    frequencyRank: 180,
    regex: /^You have taken (?<amount>\d+) damage from (?<spell>.+?) by (?<attacker>.+?)\.$/,
    build: (g) => ({
      type: "dot_tick",
      target: "You",
      amount: Number.parseInt(g["amount"] as string, 10),
      spell: g["spell"] as string,
      attacker: g["attacker"] as string,
    }),
  }),

  // "Playerfour has taken 1 damage from Feeble Poison by a gila monster hatchling."
  regexRule({
    ruleId: "dot-other",
    family: "dot_tick",
    frequencyRank: 170,
    regex: /^(?<target>.+?) has taken (?<amount>\d+) damage from (?<spell>.+?) by (?<attacker>.+?)\.$/,
    build: (g) => ({
      type: "dot_tick",
      target: g["target"] as string,
      amount: Number.parseInt(g["amount"] as string, 10),
      spell: g["spell"] as string,
      attacker: g["attacker"] as string,
    }),
  }),

  // "Playerfive has taken 28 damage by Heat Blood." — caster died/zoned.
  regexRule({
    ruleId: "dot-unknown-source",
    family: "dot_tick",
    frequencyRank: 185,
    regex: /^(?<target>.+?) has taken (?<amount>\d+) damage by (?<spell>.+?)\.$/,
    build: (g) => ({
      type: "dot_tick",
      target: g["target"] as string,
      amount: Number.parseInt(g["amount"] as string, 10),
      spell: g["spell"] as string,
      attacker: null,
    }),
  }),
];
