/**
 * Loot and coin economy (LOG_FORMAT_SPEC.md §4.13–§4.14 + corpus-discovered
 * coin_gain forms). All prices are lossless integer copper (coins.ts).
 *
 * Corpus upgrades over the spec draft:
 *  - digit-count kept-loot form ("--You have looted 3 Bone Chips …--") VERIFIED;
 *  - zero-value auto-sell "… and sold it for free." VERIFIED (spec had it U);
 *  - loot-combine form "You looted a Rusty Mining Pick from a skeletal
 *    excavator's corpse to create a Rusty Mining Pick +2" (no trailing period)
 *    VERIFIED — emitted as loot_item (the item was looted; the "+N" upgrade
 *    result stays in `raw`, ruleId `loot-item-create` marks the variant).
 */

import type { RecognizerRule } from "../rule.js";
import { regexRule } from "../rule.js";
import { COIN_LIST_PATTERN, COIN_LIST_SPACE_PATTERN, coinsToCopper } from "../coins.js";

function quantityOf(count: string): number {
  return count === "a" || count === "an" ? 1 : Number.parseInt(count, 10);
}

export const lootRules: RecognizerRule[] = [
  // "--You have looted a Fragile Pet's Skull from a fragile pet's corpse.--"
  regexRule({
    ruleId: "loot-item",
    family: "loot_item",
    frequencyRank: 210,
    regex: /^--You have looted (?<count>a|an|\d+) (?<item>.+?) from (?<corpse>.+?)'s corpse\.--$/,
    build: (g) => ({
      type: "loot_item",
      item: g["item"] as string,
      corpse: g["corpse"] as string,
      quantity: quantityOf(g["count"] as string),
    }),
  }),

  // "You looted 2 Armadillo Husk from an armadillo's corpse and sold it for 1 silver and 8 copper."
  regexRule({
    ruleId: "loot-auto-sell",
    family: "loot_auto_sell",
    frequencyRank: 300,
    regex: new RegExp(
      String.raw`^You looted (?<count>a|an|\d+) (?<item>.+?) from (?<corpse>.+?)'s corpse and sold it for (?<price>${COIN_LIST_PATTERN})\.$`,
    ),
    build: (g) => {
      const totalCopper = coinsToCopper(g["price"] as string);
      if (totalCopper === null) return null;
      return {
        type: "loot_auto_sell",
        item: g["item"] as string,
        corpse: g["corpse"] as string,
        quantity: quantityOf(g["count"] as string),
        totalCopper,
      };
    },
  }),

  // Corpus-discovered: "You receive 1 silver and 8 copper from the corpse."
  regexRule({
    ruleId: "coin-gain-corpse",
    family: "coin_gain",
    frequencyRank: 220,
    regex: new RegExp(String.raw`^You receive (?<price>${COIN_LIST_PATTERN}) from the corpse\.$`),
    build: (g) => {
      const totalCopper = coinsToCopper(g["price"] as string);
      if (totalCopper === null) return null;
      return { type: "coin_gain", totalCopper, source: "corpse" };
    },
  }),

  // Corpus-discovered: "You received 4 copper from that item."
  regexRule({
    ruleId: "coin-gain-item",
    family: "coin_gain",
    frequencyRank: 540,
    regex: new RegExp(String.raw`^You received (?<price>${COIN_LIST_PATTERN}) from that item\.$`),
    build: (g) => {
      const totalCopper = coinsToCopper(g["price"] as string);
      if (totalCopper === null) return null;
      return { type: "coin_gain", totalCopper, source: "item" };
    },
  }),

  // Corpus-discovered: "You receive 5 copper from Klok Lagnoz for the Rusty Mining Pick(s)."
  regexRule({
    ruleId: "coin-gain-merchant",
    family: "coin_gain",
    frequencyRank: 310,
    regex: new RegExp(
      String.raw`^You receive (?<price>${COIN_LIST_SPACE_PATTERN}) from (?<merchant>.+?) for the (?<item>.+?)\(s\)\.$`,
    ),
    build: (g) => {
      const totalCopper = coinsToCopper(g["price"] as string);
      if (totalCopper === null) return null;
      return {
        type: "coin_gain",
        totalCopper,
        source: "merchant",
        merchant: g["merchant"] as string,
        item: g["item"] as string,
      };
    },
  }),

  // "You looted a Rusty Mining Pick from a skeletal excavator's corpse to
  // create a Rusty Mining Pick +1" — auto-combine variant, no trailing period.
  regexRule({
    ruleId: "loot-item-create",
    family: "loot_item",
    frequencyRank: 215,
    regex: /^You looted (?<count>a|an|\d+) (?<item>.+?) from (?<corpse>.+?)'s corpse to create (?:a|an) .+$/,
    build: (g) => ({
      type: "loot_item",
      item: g["item"] as string,
      corpse: g["corpse"] as string,
      quantity: quantityOf(g["count"] as string),
    }),
  }),

  // "You looted a Master Crushbone Cell Key from Playerfive's corpse and sold
  // it for free." — zero-value sale (spec §4.14 open question, now verified).
  regexRule({
    ruleId: "loot-auto-sell-free",
    family: "loot_auto_sell",
    frequencyRank: 305,
    regex: /^You looted (?<count>a|an|\d+) (?<item>.+?) from (?<corpse>.+?)'s corpse and sold it for free\.$/,
    build: (g) => ({
      type: "loot_auto_sell",
      item: g["item"] as string,
      corpse: g["corpse"] as string,
      quantity: quantityOf(g["count"] as string),
      totalCopper: 0,
    }),
  }),
];
