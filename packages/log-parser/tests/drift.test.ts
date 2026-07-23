/**
 * Drift report (LAUNCH_DIALECT_READINESS.md §3).
 *
 * A clean beta run flags nothing; a synthetic drifted run (a few families'
 * wording changed) flags EXACTLY those families, surfaces the new unknown
 * shapes, and trips the overall-rate flag. Synthetic inputs only.
 */

import { describe, expect, it } from "vitest";

import {
  BETA_BASELINE,
  analyzeLines,
  createDefaultDialectRegistry,
  driftReport,
  FAMILY_DROP_THRESHOLD,
} from "../src/index.js";
import { betaSample, driftFamilies } from "./fixture-samples.js";

const betaRules = createDefaultDialectRegistry().get(BETA_BASELINE.dialectId)?.rules ?? [];

describe("driftReport (§3)", () => {
  it("a clean beta run flags nothing (observed == baseline distribution)", () => {
    // The full fixture set reproduces the baseline shares, so no family drops.
    const stats = analyzeLines(betaRules, betaSample());
    const report = driftReport(stats, BETA_BASELINE);
    expect(report.droppedFamilies).toEqual([]);
    expect(report.overallUnmatchedFlag).toBe(false);
    expect(report.flagged).toBe(false);
  });

  it("flags exactly the drifted families and surfaces their new shapes", () => {
    const drifted = driftFamilies(betaSample(), ["melee_hit", "heal", "chat_message"]);
    const stats = analyzeLines(betaRules, drifted);
    const report = driftReport(stats, BETA_BASELINE);

    // (b) exactly the three changed families dropped — no more, no less.
    expect(new Set(report.droppedFamilies.map((d) => d.family))).toEqual(
      new Set(["melee_hit", "heal", "chat_message"]),
    );
    for (const drift of report.droppedFamilies) {
      expect(drift.observedShare).toBe(0);
      expect(drift.relativeDrop).toBeGreaterThan(FAMILY_DROP_THRESHOLD);
    }
    // Sorted worst-first (largest relative drop / biggest family first here).
    expect(report.droppedFamilies[0]?.family).toBe("chat_message");

    // (c) the new unknown wording is surfaced, normalized + anonymized.
    expect(report.newShapes.length).toBeGreaterThan(0);
    expect(report.newShapes.some((s) => s.shape.includes("drifted"))).toBe(true);
    // Name-free: report shapes carry ONLY {shape, count} — no raw firstExample.
    for (const shape of report.newShapes) {
      expect(Object.keys(shape).sort()).toEqual(["count", "shape"]);
    }

    // (a) overall rate rose past the alert threshold, and the run is flagged.
    expect(report.overallUnmatchedFlag).toBe(true);
    expect(report.flagged).toBe(true);
  });

  it("respects configurable thresholds", () => {
    const drifted = driftFamilies(betaSample(), ["melee_hit"]);
    const stats = analyzeLines(betaRules, drifted);
    // A drop threshold above 1 can never be exceeded -> no family flagged.
    const lenient = driftReport(stats, BETA_BASELINE, { familyDropThreshold: 1.01 });
    expect(lenient.droppedFamilies).toEqual([]);
    // A huge alert rate suppresses the overall flag.
    const lenientRate = driftReport(stats, BETA_BASELINE, { driftAlertRate: 0.99 });
    expect(lenientRate.overallUnmatchedFlag).toBe(false);
  });

  it("caps surfaced shapes to topShapes", () => {
    const drifted = driftFamilies(betaSample(), ["melee_hit", "heal", "chat_message"]);
    const stats = analyzeLines(betaRules, drifted, 50);
    const report = driftReport(stats, BETA_BASELINE, { topShapes: 1 });
    expect(report.newShapes.length).toBe(1);
  });
});
