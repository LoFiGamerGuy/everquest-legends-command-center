/**
 * Spell/ability emotes (corpus-discovered family `spell_emote`).
 *
 * Two recognizers, both dictionary-driven (see emote-data.ts):
 *  - `spell-emote-self`: exact second-person/subject-less lines, `subject: null`.
 *  - `spell-emote-subject`: `<name><suffix>` with a closed suffix set and a
 *    name-shaped subject guard (letters/space/`'`/`` ` ``/`-`, ≤ 40 chars) so the
 *    rule can never swallow arbitrary sentences.
 */

import type { RecognizerRule } from "../rule.js";
import { exactRule, regexRule } from "../rule.js";
import { SELF_SPELL_EMOTES, SUBJECT_EMOTE_SUFFIXES } from "./emote-data.js";

const SUBJECT_SHAPE = /^[A-Za-z][A-Za-z`' -]{0,39}$/;

export const emoteRules: RecognizerRule[] = [
  exactRule({
    ruleId: "spell-emote-self",
    family: "spell_emote",
    frequencyRank: 100,
    entries: SELF_SPELL_EMOTES,
    build: (message) => ({ type: "spell_emote", subject: null, emote: message }),
  }),
  {
    ruleId: "spell-emote-subject",
    family: "spell_emote",
    frequencyRank: 460,
    dialectId: "eql-beta-2026-07",
    match(message) {
      for (const suffix of SUBJECT_EMOTE_SUFFIXES) {
        if (message.length > suffix.length && message.endsWith(suffix)) {
          const subject = message.slice(0, message.length - suffix.length);
          if (!SUBJECT_SHAPE.test(subject)) return null;
          return { type: "spell_emote", subject, emote: suffix.trimStart() };
        }
      }
      return null;
    },
  },

  // "You hear the barking of Tashan." / "… of the Tashani." — parameterized
  // self emote (spell name embedded).
  regexRule({
    ruleId: "spell-emote-barking",
    family: "spell_emote",
    frequencyRank: 765,
    regex: /^You hear the barking of (?:the )?\S+\.$/,
    build: (_g, message) => ({ type: "spell_emote", subject: null, emote: message }),
  }),
];
