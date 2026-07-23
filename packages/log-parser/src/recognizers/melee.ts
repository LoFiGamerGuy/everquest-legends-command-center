/**
 * Melee hit / miss recognizers (LOG_FORMAT_SPEC.md §4.1–§4.2).
 *
 * Verb lists are CLOSED sets — every verb below is corpus-verified in
 * eql-beta-2026-07 (434k-line benchmark). Add verbs only with fixtures.
 *
 * Trailing parenthesized annotations are corpus-verified on hit lines:
 * (Critical), (Riposte), (Double Bow Shot), (Riposte Critical), (Slay Undead),
 * (Finishing Blow), (Crippling Blow), (Strikethrough), (Riposte Strikethrough).
 */

import type { RecognizerRule } from "../rule.js";
import { regexRule } from "../rule.js";

/** First-person base-form verbs ("You slash …"). Corpus-verified closed set. */
export const MELEE_VERBS_FIRST = [
  "slash",
  "kick",
  "strike",
  "crush",
  "frenzy",
  "punch",
  "smite",
  "bash",
  "reave",
  "pierce",
  "backstab",
] as const;

/** Third-person s-form verbs ("… punches YOU …"). Corpus-verified closed set. */
export const MELEE_VERBS_THIRD = [
  "punches",
  "bashes",
  "kicks",
  "cleaves",
  "slashes",
  "pierces",
  "bites",
  "hits",
  "crushes",
  "strikes",
  "claws",
  "frenzies",
  "mauls",
  "backstabs",
  "smites",
  "reaves",
  "stings",
  "shoots",
  "slices",
] as const;

const FIRST = MELEE_VERBS_FIRST.join("|");
const THIRD = MELEE_VERBS_THIRD.join("|");
const ANNOTATION = String.raw`(?: \((?<annotation>[A-Za-z ]+)\))?`;

function modifiers(annotation: string | undefined): string[] {
  return annotation === undefined ? [] : [annotation];
}

/** "misses" -> "miss", "YOU riposte"/"… ripostes" -> "riposte", … */
export function normalizeMissOutcome(outcome: string): string {
  if (/^miss(?:es)?$/.test(outcome)) return "miss";
  if (/(?:^YOU riposte$|ripostes$)/.test(outcome)) return "riposte";
  if (/(?:^YOU dodge$|dodges$)/.test(outcome)) return "dodge";
  if (/(?:^YOU parry$|parries$)/.test(outcome)) return "parry";
  if (/(?:^YOU block$|blocks$)/.test(outcome)) return "block";
  if (/absorbs the blow$/.test(outcome)) return "absorb";
  // Unrecognized outcome wordings stay verbatim (visible, never guessed).
  return outcome;
}

export const meleeRules: RecognizerRule[] = [
  // "A large plague rat bites YOU for 3 points of damage." /
  // "Petone pierces a fragile pet for 4 points of damage." /
  // "You slash a greater skeleton for 25 points of damage. (Critical)"
  regexRule({
    ruleId: "melee-hit-third",
    family: "melee_hit",
    frequencyRank: 10,
    regex: new RegExp(
      String.raw`^(?<attacker>.+?) (?<verb>${THIRD}) (?<target>YOU|.+?) for (?<amount>\d+) points? of damage\.${ANNOTATION}$`,
    ),
    build: (g) => ({
      type: "melee_hit",
      attacker: g["attacker"] as string,
      target: g["target"] as string,
      verb: g["verb"] as string,
      amount: Number.parseInt(g["amount"] as string, 10),
      modifiers: modifiers(g["annotation"]),
    }),
  }),

  // "A dune spiderling tries to bite YOU, but misses!" /
  // "A wan ghoul knight tries to hit YOU, but misses! (Riposte)" /
  // "An ogre guard tries to hit YOU, but YOU dodge!"
  regexRule({
    ruleId: "melee-miss-third",
    family: "melee_miss",
    frequencyRank: 20,
    regex:
      /^(?<attacker>.+?) tries to (?<verb>[a-z]+) (?<target>YOU|.+?), but (?<outcome>.+?)!(?: \((?<annotation>[A-Za-z ]+)\))?$/,
    build: (g) => {
      const annotation = g["annotation"];
      return {
        type: "melee_miss",
        attacker: g["attacker"] as string,
        target: g["target"] as string,
        verb: g["verb"] as string,
        outcome: normalizeMissOutcome(g["outcome"] as string),
        ...(annotation === undefined ? {} : { annotation }),
      };
    },
  }),

  // "You slash an ogre guard for 12 points of damage."
  regexRule({
    ruleId: "melee-hit-you",
    family: "melee_hit",
    frequencyRank: 30,
    regex: new RegExp(
      String.raw`^You (?<verb>${FIRST}) (?<target>.+?) for (?<amount>\d+) points? of damage\.${ANNOTATION}$`,
    ),
    build: (g) => ({
      type: "melee_hit",
      attacker: "You",
      target: g["target"] as string,
      verb: g["verb"] as string,
      amount: Number.parseInt(g["amount"] as string, 10),
      modifiers: modifiers(g["annotation"]),
    }),
  }),

  // "You try to slash an ogre guard, but miss!" /
  // "You try to slash a greater skeleton, but a greater skeleton dodges!"
  regexRule({
    ruleId: "melee-miss-you",
    family: "melee_miss",
    frequencyRank: 40,
    regex:
      /^You try to (?<verb>[a-z]+) (?<target>.+?), but (?<outcome>.+?)!(?: \((?<annotation>[A-Za-z ]+)\))?$/,
    build: (g) => {
      const annotation = g["annotation"];
      return {
        type: "melee_miss",
        attacker: "You",
        target: g["target"] as string,
        verb: g["verb"] as string,
        outcome: normalizeMissOutcome(g["outcome"] as string),
        ...(annotation === undefined ? {} : { annotation }),
      };
    },
  }),
];
