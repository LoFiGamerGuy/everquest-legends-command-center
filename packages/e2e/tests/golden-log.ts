/**
 * Synthetic golden log for the end-to-end suite (issue #21, E1.1).
 *
 * NOT a real player log — none exist in-repo and none may be committed
 * (CLAUDE.md). Every line below is authored from a corpus-verified recognizer
 * shape in @eqlcc/log-parser (melee, spell/DS, heal, kill, xp, loot/coin,
 * faction, zone, stance/invocation, pet-chatter) with fabricated anonymous
 * names. We only assemble known-good shapes into one multi-actor file; we never
 * invent a new log format, and the two flavour lines are deliberately
 * unrecognized so the pipeline books them as `raw_unknown`.
 *
 * The scenario is a full M1 session shape:
 *   Session 1 (Karnor's Castle, ~17:20): a group fight against the NAMED boss
 *   "Venril Sathir" — owner Playerone + pet Pettwo + ally Allyone all deal
 *   damage; the boss HITS BACK at both the owner and the ally (that enemy damage
 *   must never be booked as ally DPS, and the boss must never be the top actor);
 *   a heal, a kill + XP, an auto-sell, a coin_gain, a faction change, one
 *   unmatched line.
 *   — then an AFK gap > 30 min splits the log into two sessions —
 *   Session 2 (The Northern Desert of Ro, ~18:15): a short TRASH fight against
 *   "a fire beetle" (article-led → unnamed encounter), the mob hits back, a kill
 *   + XP, one unmatched line.
 */

/** Owner is derived from the file name: character "Playerone", server "erudin". */
export const LOG_FILE_NAME = "eqlog_Playerone_erudin.txt";

/** The synthetic log, one message per line (chronological, valid EQ timestamps). */
export const LOG_LINES: readonly string[] = [
  // ── Session 1: setup ──
  "[Fri Jul 10 17:20:00 2026] You have entered Karnor's Castle.",
  "[Fri Jul 10 17:20:02 2026] You begin to change your stance.",
  "[Fri Jul 10 17:20:03 2026] You assume a berserker stance.",
  "[Fri Jul 10 17:20:05 2026] You begin to change your invocation.",
  "[Fri Jul 10 17:20:06 2026] You begin reciting the fury invocation.",
  "[Fri Jul 10 17:20:10 2026] Pettwo told you, 'Attacking Venril Sathir Master.'",
  // ── Session 1: the named group fight ──
  "[Fri Jul 10 17:20:12 2026] You slash Venril Sathir for 45 points of damage.",
  "[Fri Jul 10 17:20:13 2026] Allyone slashes Venril Sathir for 30 points of damage.",
  "[Fri Jul 10 17:20:14 2026] Pettwo slashes Venril Sathir for 20 points of damage.",
  "[Fri Jul 10 17:20:15 2026] Venril Sathir is burned by Pettwo's flames for 11 points of non-melee damage.",
  "[Fri Jul 10 17:20:16 2026] Venril Sathir slashes YOU for 25 points of damage.",
  "[Fri Jul 10 17:20:17 2026] Venril Sathir slashes Allyone for 18 points of damage.",
  "[Fri Jul 10 17:20:18 2026] You healed Allyone for 60 hit points by Superior Healing.",
  "[Fri Jul 10 17:20:20 2026] You slash Venril Sathir for 50 points of damage. (Critical)",
  "[Fri Jul 10 17:20:22 2026] You have slain Venril Sathir!",
  "[Fri Jul 10 17:20:22 2026] You gain experience! (4.000%)",
  // ── Session 1: economy + faction + one unmatched ──
  "[Fri Jul 10 17:20:25 2026] You looted a Rusty Dagger from Venril Sathir's corpse and sold it for 1 silver and 8 copper.",
  "[Fri Jul 10 17:20:27 2026] You receive 2 silver and 5 copper from the corpse.",
  "[Fri Jul 10 17:20:30 2026] Your faction standing with New Sebilisian Expedition has been adjusted by 100.",
  "[Fri Jul 10 17:20:35 2026] The ancient runes flicker with a pale blue radiance.",
  // ── AFK gap > 30 min → Session 2: a short trash fight ──
  "[Fri Jul 10 18:15:00 2026] You have entered The Northern Desert of Ro.",
  "[Fri Jul 10 18:15:05 2026] You slash a fire beetle for 8 points of damage.",
  "[Fri Jul 10 18:15:06 2026] a fire beetle slashes YOU for 3 points of damage.",
  "[Fri Jul 10 18:15:08 2026] You slash a fire beetle for 9 points of damage.",
  "[Fri Jul 10 18:15:10 2026] You have slain a fire beetle!",
  "[Fri Jul 10 18:15:10 2026] You gain experience! (1.000%)",
  "[Fri Jul 10 18:15:20 2026] A soft chime echoes from somewhere unseen.",
];

/** Expected event type per line, in order (asserted end-to-end). */
export const EXPECTED_TYPES: readonly string[] = [
  "zone_enter",
  "stance_change_begin",
  "stance_change",
  "invocation_change_begin",
  "invocation_change",
  "pet_chatter",
  "melee_hit",
  "melee_hit",
  "melee_hit",
  "damage_shield",
  "melee_hit",
  "melee_hit",
  "heal",
  "melee_hit",
  "kill",
  "xp_gain",
  "loot_auto_sell",
  "coin_gain",
  "faction_change",
  "raw_unknown",
  "zone_enter",
  "melee_hit",
  "melee_hit",
  "melee_hit",
  "kill",
  "xp_gain",
  "raw_unknown",
];

/** 1-based line indices (into LOG_LINES) that must be booked as raw_unknown. */
export const UNMATCHED_LINES = [20, 27] as const;

/** Number of lines to process before the simulated crash (resume cut point). */
export const CUT_AFTER_LINE = 12;

/** Full file text (every line terminated by `\n`, incl. the last). */
export function fullText(): string {
  return LOG_LINES.map((l) => `${l}\n`).join("");
}

/** Byte offset at the START of 1-based line `n` (== resume offset after line n-1). */
export function offsetOfLine(n: number): number {
  let offset = 0;
  for (let i = 0; i < n - 1; i += 1) offset += Buffer.byteLength(LOG_LINES[i] as string, "latin1") + 1;
  return offset;
}

/** The cut byte offset: start of the first line after the crash prefix. */
export function cutOffset(): number {
  return offsetOfLine(CUT_AFTER_LINE + 1);
}

/** Total byte length of the full file. */
export function fullSize(): number {
  return Buffer.byteLength(fullText(), "latin1");
}
