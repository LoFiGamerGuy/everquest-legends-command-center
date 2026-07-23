/**
 * @eqlcc/log-parser — pure-TS parser core (ARCHITECTURE.md §2–§3).
 * Depends only on @eqlcc/event-schema; runs in Node, Web Workers, anywhere.
 */

export { LineSplitter, splitLines } from "./line-reader.js";
export type { RawLine } from "./line-reader.js";
export { MESSAGE_OFFSET, messageBody, parseTimestamp } from "./timestamp.js";
export { COIN_LIST_PATTERN, COPPER_PER, coinsToCopper } from "./coins.js";
export { exactRule, regexRule } from "./rule.js";
export type { EventPayload, RecognizerRule } from "./rule.js";
export { RecognizerRegistry, allRules } from "./registry.js";
export type { Recognition } from "./registry.js";
export { LogParser } from "./parser.js";
export type { ParserOptions } from "./parser.js";
export { UnknownStats, normalizeShape } from "./unknown-stats.js";
export type { UnknownShape } from "./unknown-stats.js";
export { MELEE_VERBS_FIRST, MELEE_VERBS_THIRD, normalizeMissOutcome } from "./recognizers/melee.js";
export { SELF_SPELL_EMOTES, SUBJECT_EMOTE_SUFFIXES } from "./recognizers/emote-data.js";
export { SYSTEM_EXACT_MESSAGES } from "./recognizers/system-data.js";
