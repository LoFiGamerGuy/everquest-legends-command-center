/**
 * Damage shields (LOG_FORMAT_SPEC.md §4.5). Corpus-verified wording pairs:
 * burned/flames, pierced/thorns, tormented/frost; `YOU are … !` (received,
 * exclamation) vs `<target> is … .` (observed); owner `YOUR` for your own
 * shield. The possessive owner is pet/player attribution evidence
 * (`damage_shield_possessive`).
 *
 *   "A greater skeleton is burned by Pettwo's flames for 11 points of non-melee damage."
 *   "YOU are burned by a magician's flames for 5 points of non-melee damage!"
 *   "A Tesch Mas Gnoll is burned by YOUR flames for 4 points of non-melee damage."
 *   "YOU are pierced by Asaka L`Rei's thorns for 2 points of non-melee damage!"
 *   "Playerfive is tormented by a Nisch Mal Gnoll's frost for 6 points of non-melee damage."
 */

import type { RecognizerRule } from "../rule.js";
import { regexRule } from "../rule.js";

export const damageShieldRules: RecognizerRule[] = [
  regexRule({
    ruleId: "damage-shield",
    family: "damage_shield",
    frequencyRank: 110,
    regex:
      /^(?<target>.+?) (?:is|are) (?:burned|pierced|tormented) by (?<owner>YOUR|.+?'s) (?<element>flames|thorns|frost) for (?<amount>\d+) points? of non-melee damage[.!]$/,
    build: (g) => {
      const rawOwner = g["owner"] as string;
      return {
        type: "damage_shield",
        target: g["target"] as string,
        owner: rawOwner === "YOUR" ? "YOUR" : rawOwner.slice(0, -2),
        amount: Number.parseInt(g["amount"] as string, 10),
        element: g["element"] as string,
      };
    },
  }),
];
