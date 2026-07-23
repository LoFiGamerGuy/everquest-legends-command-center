import { describe, expect, it } from "vitest";

import { coinsToCopper } from "../src/index.js";

describe("coinsToCopper (DATA_MODEL.md §7: 1p=1000c, 1g=100c, 1s=10c)", () => {
  it("parses comma/and-joined lists (loot auto-sell, corpse coin)", () => {
    expect(coinsToCopper("1 silver and 8 copper")).toBe(18);
    expect(coinsToCopper("3 platinum, 2 gold, 1 silver and 4 copper")).toBe(3214);
    expect(coinsToCopper("6 copper")).toBe(6);
  });

  it("parses space-joined merchant lists", () => {
    expect(coinsToCopper("4 silver 5 copper")).toBe(45);
    expect(coinsToCopper("3 gold 8 silver 5 copper")).toBe(385);
  });

  it("rejects non-coin text", () => {
    expect(coinsToCopper("free")).toBeNull();
    expect(coinsToCopper("4 bananas")).toBeNull();
    expect(coinsToCopper("")).toBeNull();
  });
});
