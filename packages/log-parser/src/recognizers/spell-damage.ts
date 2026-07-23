/**
 * Direct spell damage (LOG_FORMAT_SPEC.md §4.3).
 *
 * "You hit a dune spiderling for 3 points of fire damage by Burst of Flame."
 * "a necro neophyte hit you for 8 points of magic damage by Lifetap."   (lowercase target `you` verified)
 * "Playerfive hit a Tesch Mas Gnoll for 78 points of magic damage by Smite. (Critical)"
 *
 * Schools corpus-verified: magic, disease, cold, poison, fire, unresistable, physical.
 * The school group stays open ([a-z]+) per spec — new schools surface as data,
 * not parse failures.
 */

import type { RecognizerRule } from "../rule.js";
import { regexRule } from "../rule.js";

export const spellDamageRules: RecognizerRule[] = [
  regexRule({
    ruleId: "spell-damage",
    family: "spell_damage",
    frequencyRank: 80,
    regex:
      /^(?<attacker>You|.+?) hits? (?<target>you|YOU|.+?) for (?<amount>\d+) points? of (?<school>[a-z]+) damage by (?<spell>.+?)\.(?: \((?<annotation>[A-Za-z ]+)\))?$/,
    build: (g) => {
      const annotation = g["annotation"];
      return {
        type: "spell_damage",
        attacker: g["attacker"] as string,
        target: g["target"] as string,
        amount: Number.parseInt(g["amount"] as string, 10),
        school: g["school"] as string,
        spell: g["spell"] as string,
        modifiers: annotation === undefined ? [] : [annotation],
      };
    },
  }),
];
