/**
 * Committed beta baseline (LAUNCH_DIALECT_READINESS.md §3).
 *
 * HOW THIS IS PRODUCED (provenance — reproducible, not fabricated):
 * every anonymized fixture in `tests/fixtures/eql-beta-2026-07/*.txt` is parsed
 * with the beta rule set (`allRules()`); each recognized line is tallied by its
 * rule's `family`. The counts below are those tallies (198 recognized lines
 * across the fixture set; the 1 unmatched line is the deliberate
 * `raw-unknown.txt` case). `familyShares` = count / total recognized.
 * `tests/baseline.test.ts` re-derives these counts from the fixtures on every
 * run and fails if they drift, so this data can never silently diverge from the
 * fixtures it claims to summarize.
 *
 * INTERPRETATION / caveat: the fixture set is a coverage sample (a few lines per
 * family so every rule is exercised — CONTRIBUTING fixture policy), NOT a
 * frequency-representative capture of the private 434k-line corpus. So these
 * shares are the right *shape* for drift math (each verified family has a
 * nonzero expected share, and a family dropping to `raw_unknown` shows up as a
 * relative share drop) but are NOT the corpus's true family frequencies. At
 * launch, refresh `FAMILY_COUNTS` from the measured corpus/launch fixtures
 * before trusting absolute thresholds; the machinery and its defaults are
 * unaffected. `driftReport` compares *relative* share drops, which is robust to
 * this: a family disappearing drops from its baseline share toward zero
 * regardless of the absolute magnitude.
 */

import { DIALECT_EQL_BETA_2026_07 } from "@eqlcc/event-schema";

import type { DialectBaseline } from "../dialect.js";

/**
 * Recognized-line counts per family from the beta fixture set. Regenerate after
 * fixture changes; `tests/baseline.test.ts` guards them.
 */
export const BETA_FAMILY_COUNTS: Readonly<Record<string, number>> = Object.freeze({
  ability_purchase: 4,
  cast_begin: 5,
  cast_interrupt: 6,
  cast_resume: 3,
  chat_message: 16,
  coin_gain: 7,
  damage_shield: 6,
  death: 5,
  dot_tick: 5,
  environmental_damage: 1,
  faction_change: 2,
  heal: 6,
  invocation_change: 3,
  invocation_change_begin: 1,
  kill: 3,
  level_up: 1,
  log_toggle: 3,
  loot_auto_sell: 4,
  loot_item: 5,
  melee_hit: 8,
  melee_miss: 9,
  pet_chatter: 6,
  rune_absorb: 1,
  self_damage: 1,
  skill_up: 3,
  spell_damage: 4,
  spell_emote: 12,
  spell_resist: 7,
  stance_change: 3,
  stance_change_begin: 1,
  system_message: 52,
  xp_gain: 2,
  zone_enter: 3,
});

/** Build `familyShares` (count / total) from a counts table. */
export function sharesFromCounts(
  counts: Readonly<Record<string, number>>,
): Record<string, number> {
  let total = 0;
  for (const count of Object.values(counts)) total += count;
  const shares: Record<string, number> = {};
  if (total === 0) return shares;
  for (const [family, count] of Object.entries(counts)) {
    shares[family] = count / total;
  }
  return shares;
}

/** The committed beta baseline, consumed by `driftReport` and the default CLI. */
export const BETA_BASELINE: DialectBaseline = Object.freeze({
  dialectId: DIALECT_EQL_BETA_2026_07,
  familyShares: Object.freeze(sharesFromCounts(BETA_FAMILY_COUNTS)),
  source:
    "Derived from tests/fixtures/eql-beta-2026-07/*.txt (coverage sample, 198 " +
    "recognized lines); shares = family count / total recognized. Regenerated " +
    "and guarded by tests/baseline.test.ts. Refresh from the measured corpus at launch.",
});
