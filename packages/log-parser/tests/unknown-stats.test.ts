import { describe, expect, it } from "vitest";

import { UnknownStats, normalizeShape } from "../src/index.js";

describe("normalizeShape (issue #10 triage shapes)", () => {
  it("normalizes digits to #", () => {
    expect(normalizeShape("You gain 42 things in 3 seconds.")).toBe(
      "You gain # things in # seconds.",
    );
  });

  it("normalizes quoted payloads to '…' (leading token kept for readability)", () => {
    expect(normalizeShape("Somebody tells General:2, 'buy my stuff for 5pp'")).toBe(
      "Somebody tells Name:#, '…'",
    );
  });

  it("normalizes name-like capitalized token runs", () => {
    expect(normalizeShape("A fire beetle has been slain by Guard Stoutman!")).toBe(
      "A fire beetle has been slain by Name!",
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
      shape: "Weird line # about Name.",
      count: 2,
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
