/**
 * Casting lifecycle (LOG_FORMAT_SPEC.md §4.17).
 *
 * CastInterrupt is now corpus-VERIFIED in two flavors — interrupted and fizzle —
 * each in own-cast ("Your <spell> spell …") and third-person ("<caster>'s
 * <spell> spell …") forms. ORDER CONSTRAINT: own-cast rules run before the
 * possessive rules so "Your Kilan's Animation spell fizzles!" parses as your
 * spell "Kilan's Animation", not caster "Your Kilan".
 *
 * TODO(RESEARCH_BACKLOG): out-of-mana wording as a cast failure is UNVERIFIED
 * ("Insufficient Mana to cast this spell!" is classified as a system_message —
 * it names no spell and fires outside casts too).
 */

import type { RecognizerRule } from "../rule.js";
import { regexRule } from "../rule.js";

export const castingRules: RecognizerRule[] = [
  // "You begin casting Cavorting Bones." / "Hoptor Thaggelum begins casting Animate Dead."
  regexRule({
    ruleId: "cast-begin",
    family: "cast_begin",
    frequencyRank: 50,
    regex: /^(?<caster>You|.+?) begins? casting (?<spell>.+?)\.$/,
    build: (g) => ({
      type: "cast_begin",
      caster: g["caster"] as string,
      spell: g["spell"] as string,
    }),
  }),

  // Corpus-verified bard forms: "You begin singing Chant of Battle." /
  // "Playerfive begins singing Jonthan's Whistling Warsong."
  regexRule({
    ruleId: "cast-begin-song",
    family: "cast_begin",
    frequencyRank: 610,
    regex: /^(?<caster>You|.+?) begins? singing (?<spell>.+?)\.$/,
    build: (g) => ({
      type: "cast_begin",
      caster: g["caster"] as string,
      spell: g["spell"] as string,
    }),
  }),

  // "You regain your concentration and continue your casting."
  regexRule({
    ruleId: "cast-resume",
    family: "cast_resume",
    frequencyRank: 190,
    regex: /^You regain your concentration and continue your casting\.$/,
    build: () => ({ type: "cast_resume" }),
  }),

  // Corpus-verified third-person: "A necro neophyte regains concentration and continues casting."
  regexRule({
    ruleId: "cast-resume-other",
    family: "cast_resume",
    frequencyRank: 340,
    regex: /^(?<caster>.+?) regains concentration and continues casting\.$/,
    build: (g) => ({ type: "cast_resume", caster: g["caster"] as string }),
  }),

  // "Your Light Healing spell is interrupted."
  regexRule({
    ruleId: "cast-interrupt-you",
    family: "cast_interrupt",
    frequencyRank: 290,
    regex: /^Your (?<spell>.+?) spell is interrupted\.$/,
    build: (g) => ({
      type: "cast_interrupt",
      caster: "You",
      spell: g["spell"] as string,
      reason: "interrupted",
    }),
  }),

  // "a necro neophyte pet's Lifetap spell is interrupted."
  regexRule({
    ruleId: "cast-interrupt-other",
    family: "cast_interrupt",
    frequencyRank: 330,
    regex: /^(?<caster>.+?)'s (?<spell>.+?) spell is interrupted\.$/,
    build: (g) => ({
      type: "cast_interrupt",
      caster: g["caster"] as string,
      spell: g["spell"] as string,
      reason: "interrupted",
    }),
  }),

  // "Your Lifespike spell fizzles!"
  regexRule({
    ruleId: "cast-fizzle-you",
    family: "cast_interrupt",
    frequencyRank: 470,
    regex: /^Your (?<spell>.+?) spell fizzles!$/,
    build: (g) => ({
      type: "cast_interrupt",
      caster: "You",
      spell: g["spell"] as string,
      reason: "fizzle",
    }),
  }),

  // "Playerfive's Fire Bolt spell fizzles!"
  regexRule({
    ruleId: "cast-fizzle-other",
    family: "cast_interrupt",
    frequencyRank: 480,
    regex: /^(?<caster>.+?)'s (?<spell>.+?) spell fizzles!$/,
    build: (g) => ({
      type: "cast_interrupt",
      caster: g["caster"] as string,
      spell: g["spell"] as string,
      reason: "fizzle",
    }),
  }),

  // Corpus-verified bard song failure:
  // "A missed note brings Playerfive's Elemental Rhythms to a close!"
  regexRule({
    ruleId: "cast-interrupt-song",
    family: "cast_interrupt",
    frequencyRank: 760,
    regex: /^A missed note brings (?<caster>.+?)'s (?<spell>.+?) to a close!$/,
    build: (g) => ({
      type: "cast_interrupt",
      caster: g["caster"] as string,
      spell: g["spell"] as string,
      reason: "interrupted",
    }),
  }),
];
