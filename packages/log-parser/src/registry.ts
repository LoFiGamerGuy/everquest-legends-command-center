/**
 * Recognizer registry (ARCHITECTURE.md §6, ADR-2): all rules for a dialect,
 * ordered most-frequent-first by corpus-measured `frequencyRank`; first match
 * wins. A throwing rule is disabled for the session and its lines fall through
 * to `raw_unknown` (ARCHITECTURE.md §7 — recognizer errors never abort the stream).
 */

import type { EventPayload, RecognizerRule } from "./rule.js";
import { meleeRules } from "./recognizers/melee.js";
import { spellDamageRules } from "./recognizers/spell-damage.js";
import { dotRules } from "./recognizers/dot.js";
import { damageShieldRules } from "./recognizers/damage-shield.js";
import { miscDamageRules } from "./recognizers/misc-damage.js";
import { healRules } from "./recognizers/heal.js";
import { killDeathRules } from "./recognizers/kill-death.js";
import { progressionRules } from "./recognizers/progression.js";
import { lootRules } from "./recognizers/loot.js";
import { worldRules } from "./recognizers/world.js";
import { stanceInvocationRules } from "./recognizers/stance-invocation.js";
import { castingRules } from "./recognizers/casting.js";
import { resistRules } from "./recognizers/resist.js";
import { factionRules } from "./recognizers/faction.js";
import { petRules } from "./recognizers/pet.js";
import { chatRules } from "./recognizers/chat.js";
import { emoteRules } from "./recognizers/emote.js";
import { systemRules } from "./recognizers/system.js";

export interface Recognition {
  rule: RecognizerRule;
  payload: EventPayload;
}

/** All eql-beta-2026-07 rules, unordered. */
export function allRules(): RecognizerRule[] {
  return [
    ...meleeRules,
    ...spellDamageRules,
    ...dotRules,
    ...damageShieldRules,
    ...miscDamageRules,
    ...healRules,
    ...killDeathRules,
    ...progressionRules,
    ...lootRules,
    ...worldRules,
    ...stanceInvocationRules,
    ...castingRules,
    ...resistRules,
    ...factionRules,
    ...petRules,
    ...chatRules,
    ...emoteRules,
    ...systemRules,
  ];
}

export class RecognizerRegistry {
  private readonly rules: RecognizerRule[];
  private readonly disabled = new Set<string>();
  /** ruleId -> error message for rules disabled this session. */
  readonly ruleErrors = new Map<string, string>();

  constructor(rules: RecognizerRule[] = allRules()) {
    const ids = new Set<string>();
    const ranks = new Set<number>();
    for (const rule of rules) {
      if (ids.has(rule.ruleId)) throw new Error(`duplicate ruleId: ${rule.ruleId}`);
      if (ranks.has(rule.frequencyRank)) {
        throw new Error(`duplicate frequencyRank ${rule.frequencyRank} (${rule.ruleId})`);
      }
      ids.add(rule.ruleId);
      ranks.add(rule.frequencyRank);
    }
    this.rules = [...rules].sort((a, b) => a.frequencyRank - b.frequencyRank);
  }

  /** Ordered manifest (most-frequent-first), for inspection and tests. */
  get manifest(): readonly RecognizerRule[] {
    return this.rules;
  }

  /** First matching rule's payload, or `null` (-> raw_unknown upstream). */
  recognize(message: string): Recognition | null {
    for (const rule of this.rules) {
      if (this.disabled.has(rule.ruleId)) continue;
      let payload: EventPayload | null = null;
      try {
        payload = rule.match(message);
      } catch (error) {
        this.disabled.add(rule.ruleId);
        this.ruleErrors.set(rule.ruleId, error instanceof Error ? error.message : String(error));
        continue;
      }
      if (payload !== null) return { rule, payload };
    }
    return null;
  }
}
