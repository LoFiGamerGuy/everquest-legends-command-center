/**
 * Zone changes (§4.15) and the logging toggle (§4.21).
 *
 * Zone caution per spec: classic EQ reuses "You have entered …" for PvP/arena
 * flags — the rule sits late in the order and unknown stats watch for drift.
 */

import type { RecognizerRule } from "../rule.js";
import { regexRule } from "../rule.js";

export const worldRules: RecognizerRule[] = [
  // "You have entered The Northern Desert of Ro."
  regexRule({
    ruleId: "zone-enter",
    family: "zone_enter",
    frequencyRank: 350,
    regex: /^You have entered (?<zone>.+?)\.$/,
    build: (g) => ({ type: "zone_enter", zone: g["zone"] as string }),
  }),

  // "Logging to 'eqlog.txt' is now *ON*." — session boundary hint. OFF wording
  // accepted per spec but still unverified in the corpus.
  regexRule({
    ruleId: "log-toggle",
    family: "log_toggle",
    frequencyRank: 650,
    regex: /^Logging to '(?<file>.+?)' is now \*(?<state>ON|OFF)\*\.$/,
    build: (g) => ({
      type: "log_toggle",
      file: g["file"] as string,
      state: g["state"] as "ON" | "OFF",
    }),
  }),
];
