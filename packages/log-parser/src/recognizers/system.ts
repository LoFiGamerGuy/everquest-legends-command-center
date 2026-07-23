/**
 * System/UI messages (corpus-discovered family `system_message`).
 *
 * `system-exact` matches the closed dictionary (system-data.ts); the patterned
 * rules below capture the parameterized system lines observed in the corpus
 * (ability cooldowns, spell memorization, targeting, ...). Each emits
 * `{kind, detail?}` with `kind` naming the message family.
 */

import type { RecognizerRule } from "../rule.js";
import { exactRule, regexRule } from "../rule.js";
import { SYSTEM_EXACT_MESSAGES } from "./system-data.js";

const kindByText = new Map(SYSTEM_EXACT_MESSAGES.map(([kind, text]) => [text, kind]));

function detailRule(options: {
  ruleId: string;
  frequencyRank: number;
  regex: RegExp;
  kind: string;
}): RecognizerRule {
  return regexRule({
    ruleId: options.ruleId,
    family: "system_message",
    frequencyRank: options.frequencyRank,
    regex: options.regex,
    build: (g) => {
      const detail = g["detail"];
      return {
        type: "system_message",
        kind: options.kind,
        ...(detail === undefined ? {} : { detail }),
      };
    },
  });
}

export const systemRules: RecognizerRule[] = [
  exactRule({
    ruleId: "system-exact",
    family: "system_message",
    frequencyRank: 60,
    entries: SYSTEM_EXACT_MESSAGES.map(([, text]) => text),
    build: (message) => ({
      type: "system_message",
      // The entry exists by construction of the exact-set match.
      kind: kindByText.get(message) as string,
    }),
  }),

  // "You can use the ability Skull Bash again in 1 minute(s) 30 seconds."
  detailRule({
    ruleId: "system-ability-ready",
    frequencyRank: 400,
    regex: /^You can use the ability (?<detail>.+?) again in \d+ minute\(s\) \d+ seconds\.$/,
    kind: "ability_ready",
  }),

  // "Beginning to memorize Root..." / "You have finished memorizing Root." / "You forget Root."
  detailRule({
    ruleId: "system-memorize-begin",
    frequencyRank: 440,
    regex: /^Beginning to memorize (?<detail>.+?)\.\.\.$/,
    kind: "memorize_begin",
  }),
  detailRule({
    ruleId: "system-memorize-done",
    frequencyRank: 445,
    regex: /^You have finished memorizing (?<detail>.+?)\.$/,
    kind: "memorize_done",
  }),
  detailRule({
    ruleId: "system-spell-forget",
    frequencyRank: 450,
    regex: /^You forget (?<detail>.+?)\.$/,
    kind: "spell_forget",
  }),

  // "Targeted (NPC): a decaying skeleton" / "Targeted (Merchant): Klok Lagnoz"
  // Captured category (npc/merchant/banker/player/corpse/class-GM …) is kept
  // as a structured, lowercased field.
  regexRule({
    ruleId: "system-targeted",
    family: "system_message",
    frequencyRank: 410,
    regex: /^Targeted \((?<category>[A-Za-z ]+)\): (?<detail>.+)$/,
    build: (g) => ({
      type: "system_message",
      kind: "targeted",
      detail: g["detail"] as string,
      category: (g["category"] as string).toLowerCase(),
    }),
  }),

  // "You activate Skull Bash."
  detailRule({
    ruleId: "system-ability-activate",
    frequencyRank: 420,
    regex: /^You activate (?<detail>.+?)\.$/,
    kind: "ability_activate",
  }),

  // "Spell set combat1 loaded." / "Spell set buffs 1 loaded."
  detailRule({
    ruleId: "system-spell-set-loaded",
    frequencyRank: 455,
    regex: /^Spell set (?<detail>.+?) loaded\.$/,
    kind: "spell_set_loaded",
  }),

  // "You have gained an ability point!  You now have 2 ability points." (double space verified)
  detailRule({
    ruleId: "system-ability-point",
    frequencyRank: 465,
    regex: /^You have gained an ability point! {2}You now have (?<detail>\d+) ability points?\.$/,
    kind: "ability_point_gain",
  }),

  // "Your total time entitled on this account is approximately 0 years, 24 days."
  detailRule({
    ruleId: "system-account-time",
    frequencyRank: 670,
    regex: /^Your total time entitled on this account is approximately (?<detail>\d+ years?, \d+ days?)\.$/,
    kind: "account_time",
  }),

  // "Stand close to and right click on the NPC to attack it." (him/her/Merchant/Banker/GM variants verified)
  detailRule({
    ruleId: "system-interaction-hint",
    frequencyRank: 675,
    regex: /^Stand close to and right click on the (?<detail>.+?) to .+\.$/,
    kind: "interaction_hint",
  }),

  // "You could not give item Summoned: Dagger to your pet"
  detailRule({
    ruleId: "system-pet-give-failed",
    frequencyRank: 680,
    regex: /^You could not give item (?<detail>.+?) to your pet$/,
    kind: "pet_give_failed",
  }),

  // "Playertwentythree was partially successful in capturing a sturdy skeleton's attention."
  detailRule({
    ruleId: "system-taunt-partial",
    frequencyRank: 685,
    regex: /^(?<detail>.+?) was partially successful in capturing .+?'s attention\.$/,
    kind: "taunt_partial",
  }),

  // "Beginning to scribe True North..." / "You have finished scribing True North."
  detailRule({
    ruleId: "system-scribe-begin",
    frequencyRank: 446,
    regex: /^Beginning to scribe (?<detail>.+?)\.\.\.$/,
    kind: "scribe_begin",
  }),
  detailRule({
    ruleId: "system-scribe-done",
    frequencyRank: 447,
    regex: /^You have finished scribing (?<detail>.+?)\.$/,
    kind: "scribe_done",
  }),

  // "You have been granted the following spell: Minor Healing."
  detailRule({
    ruleId: "system-spell-granted",
    frequencyRank: 700,
    regex: /^You have been granted the following spell: (?<detail>.+?)\.$/,
    kind: "spell_granted",
  }),

  // "You have successfully merged two items together to create a new item: Splintering Club +1"
  detailRule({
    ruleId: "system-item-merge",
    frequencyRank: 405,
    regex: /^You have successfully merged two items together to create a new item: (?<detail>.+)$/,
    kind: "item_merge",
  }),

  // "You successfully destroyed 1 Letter For Doug."
  detailRule({
    ruleId: "system-item-destroyed",
    frequencyRank: 705,
    regex: /^You successfully destroyed (?<detail>\d+ .+?)\.$/,
    kind: "item_destroyed",
  }),

  // "You have gained the ability to use Archery." (no-cost form; distinct from §4.12)
  detailRule({
    ruleId: "system-ability-granted",
    frequencyRank: 710,
    regex: /^You have gained the ability to use (?<detail>.+?)\.$/,
    kind: "ability_granted",
  }),

  // "You offered 1 Fragile Pet's Skull to Dead Doug." / "You complete the trade with Old Doug."
  detailRule({
    ruleId: "system-trade-offer",
    frequencyRank: 715,
    regex: /^You offered (?<detail>\d+ .+?) to .+?\.$/,
    kind: "trade_offer",
  }),
  detailRule({
    ruleId: "system-trade-complete",
    frequencyRank: 720,
    regex: /^You complete the trade with (?<detail>.+?)\.$/,
    kind: "trade_complete",
  }),

  // "It will take about 25 more seconds to prepare your camp."
  detailRule({
    ruleId: "system-camp-countdown",
    frequencyRank: 725,
    regex: /^It will take about (?<detail>\d+) more seconds to prepare your camp\.$/,
    kind: "camp_countdown",
  }),

  // "You have completed achievement: East Freeport Traveler"
  detailRule({
    ruleId: "system-achievement",
    frequencyRank: 730,
    regex: /^You have completed achievement: (?<detail>.+)$/,
    kind: "achievement",
  }),

  // "Channels: 1=NewPlayers(117), 2=General(241)"
  detailRule({
    ruleId: "system-channels-list",
    frequencyRank: 735,
    regex: /^Channels: (?<detail>\d+=.+)$/,
    kind: "channels_list",
  }),

  // "You will now use Kick while auto attacking."
  detailRule({
    ruleId: "system-auto-attack-skill",
    frequencyRank: 740,
    regex: /^You will now use (?<detail>.+?) while auto attacking\.$/,
    kind: "auto_attack_skill",
  }),

  // "You purchased 1 Spell: True North from Zealot Zorshais for  4 silver 7 copper."
  // (double space before the price; free purchases end "for ." — both corpus-verified)
  detailRule({
    ruleId: "system-purchase",
    frequencyRank: 745,
    regex: /^You purchased (?<detail>\d+ .+?) from .+? for(?: {2}.+?| ?)\.$/,
    kind: "purchase",
  }),

  // "Your pet's Haze spell has worn off."
  detailRule({
    ruleId: "system-pet-spell-worn",
    frequencyRank: 750,
    regex: /^Your pet's (?<detail>.+?) spell has worn off\.$/,
    kind: "pet_spell_worn",
  }),

  // "Your Clinging Darkness spell has worn off of an asp."
  detailRule({
    ruleId: "system-spell-worn-target",
    frequencyRank: 755,
    regex: /^Your (?<detail>.+?) spell has worn off of .+?\.$/,
    kind: "spell_worn",
  }),

  // "You have learned Asp Venom!" / "You have been granted the following discipline: Asp Venom."
  detailRule({
    ruleId: "system-learned",
    frequencyRank: 770,
    regex: /^You have learned (?<detail>.+?)!$/,
    kind: "learned",
  }),
  detailRule({
    ruleId: "system-discipline-granted",
    frequencyRank: 775,
    regex: /^You have been granted the following discipline: (?<detail>.+?)\.$/,
    kind: "discipline_granted",
  }),

  // /played output block: "This session: 30 minutes and 26 seconds" /
  // "Total time playing Playerone: 3 hours and 51 minutes" /
  // "Playerone's birthdate: Thursday, July 16, 2026 15:34:29." /
  // "Playerone's age: 0 years (Earth time). 0 years (Norrathian time)."
  detailRule({
    ruleId: "system-session-time",
    frequencyRank: 780,
    regex: /^This session: (?<detail>.+)$/,
    kind: "session_time",
  }),
  detailRule({
    ruleId: "system-played-time",
    frequencyRank: 785,
    regex: /^Total time playing (?<detail>.+?): .+$/,
    kind: "played_time",
  }),
  detailRule({
    ruleId: "system-played-birthdate",
    frequencyRank: 790,
    regex: /^(?<detail>\S+)'s birthdate: [A-Z].+\d\.$/,
    kind: "played_birthdate",
  }),
  detailRule({
    ruleId: "system-played-age",
    frequencyRank: 795,
    regex: /^(?<detail>\S+)'s age: \d+ years \(Earth time\)\. \d+ years \(Norrathian time\)\.$/,
    kind: "played_age",
  }),

  // "Player Playerone creating instance Befallen 463." / "Befallen is now available to you."
  detailRule({
    ruleId: "system-instance-create",
    frequencyRank: 800,
    regex: /^Player (?<detail>\S+) creating instance .+\.$/,
    kind: "instance_create",
  }),
  detailRule({
    ruleId: "system-instance-available",
    frequencyRank: 805,
    regex: /^(?<detail>.+?) is now available to you\.$/,
    kind: "instance_available",
  }),

  // "Only Equipment items may be placed in the Equipment key ring."
  detailRule({
    ruleId: "system-keyring-hint",
    frequencyRank: 810,
    regex: /^Only (?<detail>.+?) items may be placed in the .+? key ring\.$/,
    kind: "keyring_hint",
  }),

  // Bandage caps (note the verified trailing space).
  detailRule({
    ruleId: "system-bandage-cap-self",
    frequencyRank: 815,
    regex: /^You cannot be bandaged past (?<detail>\d+) percent of your max hit points\. $/,
    kind: "bandage_cap_self",
  }),
  detailRule({
    ruleId: "system-bandage-cap-target",
    frequencyRank: 820,
    regex: /^You cannot bandage your target past (?<detail>\d+) percent of their hit points\. $/,
    kind: "bandage_cap_target",
  }),

  // "Spell set combat1 saved."
  detailRule({
    ruleId: "system-spell-set-saved",
    frequencyRank: 825,
    regex: /^Spell set (?<detail>.+?) saved\.$/,
    kind: "spell_set_saved",
  }),

  // "You will now use Round Kick instead of Kick while attacking."
  detailRule({
    ruleId: "system-auto-attack-skill-swap",
    frequencyRank: 830,
    regex: /^You will now use (?<detail>.+?) instead of .+? while attacking\.$/,
    kind: "auto_attack_skill_swap",
  }),

  // "You need to wait 37 more seconds before you can Mend again."
  detailRule({
    ruleId: "system-ability-wait",
    frequencyRank: 835,
    regex: /^You need to wait \d+ more seconds before you can (?<detail>.+?) again\.$/,
    kind: "ability_wait",
  }),

  // Taunt outcomes: "Playerfive failed to taunt a fire drake." /
  // "Playerfive has captured a fire elemental's attention!"
  detailRule({
    ruleId: "system-taunt-failed",
    frequencyRank: 840,
    regex: /^(?<detail>\S+) failed to taunt .+\.$/,
    kind: "taunt_failed",
  }),
  detailRule({
    ruleId: "system-taunt-captured",
    frequencyRank: 845,
    regex: /^(?<detail>\S+) has captured .+?'s attention!$/,
    kind: "taunt_captured",
  }),

  // "Channel NewPlayers was too full to join"
  detailRule({
    ruleId: "system-channel-full",
    frequencyRank: 850,
    regex: /^Channel (?<detail>\S+) was too full to join$/,
    kind: "channel_full",
  }),

  // "You are missing Snake Scales." — reagent-specific missing-component form.
  detailRule({
    ruleId: "system-missing-reagent",
    frequencyRank: 690,
    regex: /^You are missing (?<detail>.+?)\.$/,
    kind: "missing_reagent",
  }),
];
