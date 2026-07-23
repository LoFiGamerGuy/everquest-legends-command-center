/**
 * Faction adjustments (LOG_FORMAT_SPEC.md §4.18). The negative form
 * ("… adjusted by -3.") is now corpus-VERIFIED (spec had assumed symmetry).
 */

import type { RecognizerRule } from "../rule.js";
import { regexRule } from "../rule.js";

export const factionRules: RecognizerRule[] = [
  regexRule({
    ruleId: "faction-change",
    family: "faction_change",
    frequencyRank: 250,
    regex: /^Your faction standing with (?<faction>.+?) has been adjusted by (?<delta>-?\d+)\.$/,
    build: (g) => ({
      type: "faction_change",
      faction: g["faction"] as string,
      delta: Number.parseInt(g["delta"] as string, 10),
    }),
  }),
];
