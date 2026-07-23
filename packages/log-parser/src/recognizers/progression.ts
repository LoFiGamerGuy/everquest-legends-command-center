/**
 * Progression: XP (§4.10), level-ups (§4.11), ability purchases (§4.12), and
 * skill-ups (§4.22 — now corpus-VERIFIED: classic wording confirmed in EQL).
 *
 * XP percentages are lossless integer milli-percent ('1.019%' -> 1019).
 * The 3-decimal precision is pinned by the regex: a precision change after a
 * patch surfaces as unknown lines (the health metric), not silent rounding.
 *
 * TODO(RESEARCH_BACKLOG): bare "You gain experience!" (no percent) observed
 * twice in the corpus; needs a decision on payload before recognizing (XpGain
 * requires percentMilli). AA-earn wording other than the ability-point system
 * message is still UNVERIFIED.
 */

import type { RecognizerRule } from "../rule.js";
import { regexRule } from "../rule.js";

function milliPercent(whole: string, frac: string): number {
  return Number.parseInt(whole, 10) * 1000 + Number.parseInt(frac, 10);
}

export const progressionRules: RecognizerRule[] = [
  // "You gain experience! (1.019%)"
  regexRule({
    ruleId: "xp-gain",
    family: "xp_gain",
    frequencyRank: 150,
    regex: /^You gain experience! \((?<whole>\d+)\.(?<frac>\d{3})%\)$/,
    build: (g) => ({
      type: "xp_gain",
      percentMilli: milliPercent(g["whole"] as string, g["frac"] as string),
    }),
  }),

  // Corpus-verified party variant: "You gain party experience! (2.315%)"
  regexRule({
    ruleId: "xp-gain-party",
    family: "xp_gain",
    frequencyRank: 620,
    regex: /^You gain party experience! \((?<whole>\d+)\.(?<frac>\d{3})%\)$/,
    build: (g) => ({
      type: "xp_gain",
      percentMilli: milliPercent(g["whole"] as string, g["frac"] as string),
    }),
  }),

  // "You have gained a level! Welcome to level 2!"
  regexRule({
    ruleId: "level-up",
    family: "level_up",
    frequencyRank: 490,
    regex: /^You have gained a level! Welcome to level (?<level>\d+)!$/,
    build: (g) => ({ type: "level_up", level: Number.parseInt(g["level"] as string, 10) }),
  }),

  // 'You have gained the ability "Origin" at a cost of 0 ability points.'
  regexRule({
    ruleId: "ability-purchase",
    family: "ability_purchase",
    frequencyRank: 530,
    regex: /^You have gained the ability "(?<ability>.+?)" at a cost of (?<cost>\d+) ability points?\.$/,
    build: (g) => ({
      type: "ability_purchase",
      ability: g["ability"] as string,
      costPoints: Number.parseInt(g["cost"] as string, 10),
    }),
  }),

  // §4.22 corpus-VERIFIED: "You have become better at 1H Slashing! (12)"
  regexRule({
    ruleId: "skill-up",
    family: "skill_up",
    frequencyRank: 130,
    regex: /^You have become better at (?<skill>.+?)! \((?<value>\d+)\)$/,
    build: (g) => ({
      type: "skill_up",
      skill: g["skill"] as string,
      value: Number.parseInt(g["value"] as string, 10),
    }),
  }),

  // Corpus-verified AA upgrade form: "You have improved Innate Regeneration 2
  // at a cost of 1 ability point."
  regexRule({
    ruleId: "ability-improve",
    family: "ability_purchase",
    frequencyRank: 535,
    regex: /^You have improved (?<ability>.+?) at a cost of (?<cost>\d+) ability points?\.$/,
    build: (g) => ({
      type: "ability_purchase",
      ability: g["ability"] as string,
      costPoints: Number.parseInt(g["cost"] as string, 10),
    }),
  }),
];
