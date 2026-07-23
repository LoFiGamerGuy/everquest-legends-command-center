/**
 * Chat (LOG_FORMAT_SPEC.md §4.20 + corpus-verified additional forms).
 *
 * Numbered channels: "Playerfive tells General:2, '…'" — corpus shows channel
 * names may carry digits ("general1:1", "NewPlayers1:2"), so the channel group
 * is [A-Za-z][A-Za-z0-9]* (spec had [A-Za-z]+; evidence-driven widening).
 *
 * Corpus-verified non-numbered forms map `channel` to a normalized kind:
 *   say   — "An earth elemental says, 'Time to die, Playerone.'"
 *   shout — "Playerfive shouts, '…'"
 *   ooc   — "Playerfive says out of character, '…'"
 *   group — "Playerfive tells the group, '…'" / "You tell your party, '…'"
 *   tell  — "Playerfive tells you, '…'" / "You told Playerfive, '…'"
 *
 * ORDER CONSTRAINT: pet-chatter (pet.ts) runs before chat-tell-npc.
 * Still-unverified classic channels (guild, raid, auction) get NO rule —
 * TODO(RESEARCH_BACKLOG).
 */

import type { EventPayload, RecognizerRule } from "../rule.js";
import { regexRule } from "../rule.js";

function chat(
  speaker: string,
  channel: string,
  message: string,
  channelNumber?: number,
): EventPayload {
  return {
    type: "chat_message",
    speaker,
    channel,
    message,
    ...(channelNumber === undefined ? {} : { channelNumber }),
  };
}

/** Direct tell with a named recipient ("You" for received tells). */
function tell(speaker: string, recipient: string, message: string): EventPayload {
  return { type: "chat_message", speaker, channel: "tell", recipient, message };
}

export const chatRules: RecognizerRule[] = [
  // "Playerfive tells General:2, '…'"
  regexRule({
    ruleId: "chat-channel",
    family: "chat_message",
    frequencyRank: 140,
    regex: /^(?<speaker>\S+) tells (?<channel>[A-Za-z][A-Za-z0-9]*):(?<number>\d+), '(?<message>.+)'$/,
    build: (g) =>
      chat(
        g["speaker"] as string,
        g["channel"] as string,
        g["message"] as string,
        Number.parseInt(g["number"] as string, 10),
      ),
  }),

  // "You tell General:1, '…'"
  regexRule({
    ruleId: "chat-channel-you",
    family: "chat_message",
    frequencyRank: 510,
    regex: /^You tell (?<channel>[A-Za-z][A-Za-z0-9]*):(?<number>\d+), '(?<message>.+)'$/,
    build: (g) =>
      chat(
        "You",
        g["channel"] as string,
        g["message"] as string,
        Number.parseInt(g["number"] as string, 10),
      ),
  }),

  // "Playerfive says out of character, '…'" — before chat-say by construction.
  regexRule({
    ruleId: "chat-ooc",
    family: "chat_message",
    frequencyRank: 550,
    regex: /^(?<speaker>.+?) says out of character, '(?<message>.+)'$/,
    build: (g) => chat(g["speaker"] as string, "ooc", g["message"] as string),
  }),

  // "An earth elemental says, '…'" (NPC + player say share the wording).
  regexRule({
    ruleId: "chat-say",
    family: "chat_message",
    frequencyRank: 200,
    regex: /^(?<speaker>.+?) says?, '(?<message>.+)'$/,
    build: (g) => chat(g["speaker"] as string, "say", g["message"] as string),
  }),

  // "You say, '…'" — accepted by chat-say ("You says," never occurs; the
  // regex's says? covers "You say,"). Kept as one rule; speaker verbatim "You".

  // "Playerfive shouts, '…'"
  regexRule({
    ruleId: "chat-shout",
    family: "chat_message",
    frequencyRank: 560,
    regex: /^(?<speaker>.+?) shouts?, '(?<message>.+)'$/,
    build: (g) => chat(g["speaker"] as string, "shout", g["message"] as string),
  }),

  // "Playertwentyone tells you, 'did youi make it?'"
  regexRule({
    ruleId: "chat-tell-recv",
    family: "chat_message",
    frequencyRank: 570,
    regex: /^(?<speaker>.+?) tells you, '(?<message>.+)'$/,
    build: (g) => tell(g["speaker"] as string, "You", g["message"] as string),
  }),

  // "You told Playertwentyone, '…'"
  regexRule({
    ruleId: "chat-tell-sent",
    family: "chat_message",
    frequencyRank: 580,
    regex: /^You told (?<recipient>\S+), '(?<message>.+)'$/,
    build: (g) => tell("You", g["recipient"] as string, g["message"] as string),
  }),

  // NPC/merchant tells — any "told you" line pet-chatter did not claim via its
  // "… Master." suffix: "Klok Lagnoz told you, 'I'll give you 2 gold …'" /
  // "Dougina told you, 'That'll be 0 money for the Package for Old Doug.'"
  regexRule({
    ruleId: "chat-tell-npc",
    family: "chat_message",
    frequencyRank: 280,
    regex: /^(?<speaker>.+?) told you, '(?<message>.+)'$/,
    build: (g) => tell(g["speaker"] as string, "You", g["message"] as string),
  }),

  // "Playertwentyone tells the group, 'hey hey …'"
  regexRule({
    ruleId: "chat-group",
    family: "chat_message",
    frequencyRank: 660,
    regex: /^(?<speaker>.+?) tells the group, '(?<message>.+)'$/,
    build: (g) => chat(g["speaker"] as string, "group", g["message"] as string),
  }),

  // NPC aggro dialogue: "A Lteth Mal Gnoll growls fiercely; saliva foaming
  // around its ferocious, jagged maw, 'This is our home now! …'"
  regexRule({
    ruleId: "chat-npc-growl",
    family: "chat_message",
    frequencyRank: 672,
    regex: /^(?<speaker>.+?) growls fiercely; saliva foaming around its ferocious, jagged maw, '(?<message>.+)'$/,
    build: (g) => chat(g["speaker"] as string, "say", g["message"] as string),
  }),

  // "You tell your party, 'hi thank you'"
  regexRule({
    ruleId: "chat-group-you",
    family: "chat_message",
    frequencyRank: 665,
    regex: /^You tell your party, '(?<message>.+)'$/,
    build: (g) => chat("You", "group", g["message"] as string),
  }),
];
