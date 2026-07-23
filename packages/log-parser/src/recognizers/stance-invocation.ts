/**
 * EQL-specific stance & invocation mechanics (LOG_FORMAT_SPEC.md §4.16) —
 * first-class analytics dimensions (ADR-10).
 *
 * Corpus-verified stances now include the "an" article form:
 * offensive, evasive, balanced, striker, defensive, mage hunter, berserker, channeler.
 * `InvocationChange` is emitted at the "begin reciting" line until a completion
 * line is verified (spec open question).
 */

import type { RecognizerRule } from "../rule.js";
import { regexRule } from "../rule.js";

export const stanceInvocationRules: RecognizerRule[] = [
  // "You begin to change your stance."
  regexRule({
    ruleId: "stance-change-begin",
    family: "stance_change_begin",
    frequencyRank: 360,
    regex: /^You begin to change your stance\.$/,
    build: () => ({ type: "stance_change_begin" }),
  }),

  // "You assume a berserker stance." / "You assume an offensive stance."
  regexRule({
    ruleId: "stance-change",
    family: "stance_change",
    frequencyRank: 390,
    regex: /^You assume an? (?<stance>.+?) stance\.$/,
    build: (g) => ({ type: "stance_change", stance: g["stance"] as string }),
  }),

  // "You begin to change your invocation."
  regexRule({
    ruleId: "invocation-change-begin",
    family: "invocation_change_begin",
    frequencyRank: 500,
    regex: /^You begin to change your invocation\.$/,
    build: () => ({ type: "invocation_change_begin" }),
  }),

  // "You begin reciting the recovery invocation."
  regexRule({
    ruleId: "invocation-change",
    family: "invocation_change",
    frequencyRank: 520,
    regex: /^You begin reciting the (?<invocation>.+?) invocation\.$/,
    build: (g) => ({ type: "invocation_change", invocation: g["invocation"] as string }),
  }),
];
