import { describe, expect, it } from "vitest";

import { UnknownStats, normalizeShape } from "../src/index.js";

describe("normalizeShape (issue #10 triage shapes)", () => {
  it("normalizes digits to #", () => {
    expect(normalizeShape("You gain 42 things in 3 seconds.")).toBe(
      "You gain # things in # seconds.",
    );
  });

  it("normalizes quoted payloads to '…' and anonymizes the leading name", () => {
    expect(normalizeShape("Somebody tells General:2, 'buy my stuff for 5pp'")).toBe(
      "Name tells Name:#, '…'",
    );
  });

  it("normalizes name-like capitalized token runs (article opener kept)", () => {
    expect(normalizeShape("A fire beetle has been slain by Guard Stoutman!")).toBe(
      "A fire beetle has been slain by Name!",
    );
  });

  it("anonymizes a LEADING player name (no leak) in a combat line", () => {
    expect(normalizeShape("Aeronwyn hits a coyote for 5 points of damage.")).toBe(
      "Name hits a coyote for # points of damage.",
    );
  });

  it("anonymizes a leading name in a guild line", () => {
    expect(normalizeShape("Soandso has joined the guild.")).toBe("Name has joined the guild.");
  });

  it("keeps whitelisted openers You/Your verbatim", () => {
    // "You" kept; later capitalized zone words still anonymize (no name leaks).
    expect(normalizeShape("You have entered the Plane of Knowledge.")).toBe(
      "You have entered the Name of Name.",
    );
    expect(normalizeShape("Your faction standing has improved.")).toBe(
      "Your faction standing has improved.",
    );
  });
});

describe("UnknownStats", () => {
  it("aggregates by shape with count + first raw example", () => {
    const stats = new UnknownStats();
    stats.add("Weird line 1 about Bob.", 10);
    stats.add("Weird line 2 about Alice.", 20);
    stats.add("Entirely different.", 30);
    expect(stats.total).toBe(3);
    expect(stats.distinctShapes).toBe(2);
    const top = stats.top(20);
    expect(top[0]).toEqual({
      shape: "Name line # about Name.",
      count: 2,
      // firstExample stays raw here — this is the LOCAL diagnostic store, not the
      // shareable drift surface (which carries only {shape, count}).
      firstExample: "Weird line 1 about Bob.",
      firstLineNo: 10,
    });
  });

  it("top(n) truncates", () => {
    const stats = new UnknownStats();
    stats.add("a 1", 1);
    stats.add("b 2", 2);
    expect(stats.top(1)).toHaveLength(1);
  });
});
