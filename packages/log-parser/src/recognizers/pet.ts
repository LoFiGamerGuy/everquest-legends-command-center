/**
 * Pet chatter (LOG_FORMAT_SPEC.md §4.19) — attribution gold (`pet_chatter`
 * evidence, confidence 0.95).
 *
 * The discriminator is the ", Master."/"… Master." SUFFIX inside the quoted
 * message — per the spec's own reading ("a bare-named entity telling *you*
 * '… Master.' is your pet"). A generic "told you" line WITHOUT that suffix is
 * an NPC/merchant tell and must emit chat_message (chat.ts `chat-tell-npc`),
 * never 0.95-confidence pet evidence. Corpus-verified pet senders include the
 * multi-token beastlord form "Playerfour`s warder told you, '…'", so the
 * sender group is `.+?`, not `\S+`.
 *
 * Corpus also verified unwrapped pet reports carrying no pet name:
 *   "Failed to taunt my target, Master."
 *   "Failed to capture a fire beetle's attention, Master."
 *   "Taunting attackers as normal, Master."
 *   "Captured a fire elemental's attention, Master!"
 * → `pet: null` (explicit, never guessed; resolver may correlate later).
 */

import type { RecognizerRule } from "../rule.js";
import { regexRule } from "../rule.js";

const ATTACKING = /^Attacking (?<target>.+?) Master\.$/;

export const petRules: RecognizerRule[] = [
  // "Petone told you, 'Attacking a dune spiderling Master.'" /
  // "Playerfour`s warder told you, 'Attacking a forest drakeling Master.'" /
  // "Petone told you, 'I am unable to wake a necro acolyte, Master.'"
  regexRule({
    ruleId: "pet-chatter",
    family: "pet_chatter",
    frequencyRank: 270,
    regex: /^(?<pet>.+?) told you, '(?<message>.+ Master\.)'$/,
    build: (g) => {
      const message = g["message"] as string;
      const attacking = ATTACKING.exec(message);
      const petTarget = attacking?.groups?.["target"];
      return {
        type: "pet_chatter",
        pet: g["pet"] as string,
        message,
        ...(petTarget === undefined ? {} : { petTarget }),
      };
    },
  }),

  // Unwrapped pet report lines (no pet name in the line).
  regexRule({
    ruleId: "pet-report",
    family: "pet_chatter",
    frequencyRank: 590,
    regex: /^(?<message>(?:Failed to|Taunting|Captured) .+, Master[.!])$/,
    build: (g) => ({
      type: "pet_chatter",
      pet: null,
      message: g["message"] as string,
    }),
  }),
];
