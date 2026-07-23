/**
 * Kills and deaths (LOG_FORMAT_SPEC.md §4.9).
 *
 * ORDER CONSTRAINT: `death-you` ("You have been slain by …!") must run before
 * `kill-other` ("<target> has been slain by …!") — the kill regex would
 * otherwise capture the death line with target "You". Encoded in the ranks.
 *
 * "<entity> died." is corpus-verified for multi-word entities too
 * ("A large skeleton died.", "You died.") — spec §4.9 originally showed the
 * bare-name form only.
 */

import type { RecognizerRule } from "../rule.js";
import { regexRule } from "../rule.js";

export const killDeathRules: RecognizerRule[] = [
  // "You have slain a dune spiderling!"
  regexRule({
    ruleId: "kill-you",
    family: "kill",
    frequencyRank: 160,
    regex: /^You have slain (?<target>.+?)!$/,
    build: (g) => ({ type: "kill", killer: "You", target: g["target"] as string }),
  }),

  // Corpus-verified own death: "You have been slain by an ogre guard!"
  regexRule({
    ruleId: "death-you",
    family: "death",
    frequencyRank: 230,
    regex: /^You have been slain by (?<killer>.+?)!$/,
    build: (g) => ({ type: "death", entity: "You", killer: g["killer"] as string }),
  }),

  // "A fragile pet has been slain by Petone!"
  regexRule({
    ruleId: "kill-other",
    family: "kill",
    frequencyRank: 240,
    regex: /^(?<target>.+?) has been slain by (?<killer>.+?)!$/,
    build: (g) => ({ type: "kill", killer: g["killer"] as string, target: g["target"] as string }),
  }),

  // "Playerthree died." / "A large skeleton died." / "You died." — killer unknown.
  regexRule({
    ruleId: "death-bare",
    family: "death",
    frequencyRank: 600,
    regex: /^(?<entity>.+?) died\.$/,
    build: (g) => ({ type: "death", entity: g["entity"] as string, killer: null }),
  }),
];
