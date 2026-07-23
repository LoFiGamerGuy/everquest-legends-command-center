/**
 * Heals (LOG_FORMAT_SPEC.md §4.7).
 *
 *   "You healed Playerone for 4 hit points by Lifetap."
 *   "Petone healed itself for 0 (4) hit points by Lifetap."       (0-point heals are real)
 *   "You healed Playertwo for 141 (399) hit points by Greater Healing."  (parenthesized = uncapped)
 *   "Playerfive healed herself for 5 hit points."                 (corpus-verified spell-less form)
 */

import type { RecognizerRule } from "../rule.js";
import { regexRule } from "../rule.js";

export const healRules: RecognizerRule[] = [
  regexRule({
    ruleId: "heal",
    family: "heal",
    frequencyRank: 90,
    regex:
      /^(?<healer>You|.+?) healed (?<target>itself|himself|herself|.+?) for (?<amount>\d+)(?: \((?<uncapped>\d+)\))? hit points?(?: by (?<spell>.+?))?\.$/,
    build: (g) => {
      const uncapped = g["uncapped"];
      const spell = g["spell"];
      return {
        type: "heal",
        healer: g["healer"] as string,
        target: g["target"] as string,
        amount: Number.parseInt(g["amount"] as string, 10),
        ...(uncapped === undefined ? {} : { uncappedAmount: Number.parseInt(uncapped, 10) }),
        ...(spell === undefined ? {} : { spell }),
      };
    },
  }),
];
