/**
 * Dialect detection (LAUNCH_DIALECT_READINESS.md §2).
 *
 * Synthetic inputs only. Covers: beta detects as beta (single- and
 * multi-dialect), a drifted sample detects as unknown/low-confidence, ties and
 * all-poor -> unknown, single-dialect zero-behavior-change, and the explicit
 * marker hook.
 */

import { describe, expect, it } from "vitest";

import { DIALECT_EQL_BETA_2026_07 } from "@eqlcc/event-schema";

import {
  DialectRegistry,
  createDefaultDialectRegistry,
  detectDialect,
  detectExplicitMarker,
  sampleForDetection,
  allRules,
  regexRule,
  UNKNOWN_DIALECT,
} from "../src/index.js";
import type { RecognizerRule } from "../src/index.js";
import { betaSample, driftFamilies } from "./fixture-samples.js";

const OTHER_DIALECT = "eql-synth-other-test";

/** A synthetic dialect that only understands "SYNTH ..." lines (never beta). */
function otherDialectRegistry(): DialectRegistry {
  const registry = createDefaultDialectRegistry();
  const synthRule: RecognizerRule = regexRule({
    ruleId: "synth-only",
    family: "synth",
    frequencyRank: 1,
    dialectId: OTHER_DIALECT,
    regex: /^SYNTHONLY (?<n>\d+)$/,
    build: () => ({ type: "system_message", kind: "synth" }),
  });
  registry.register({ id: OTHER_DIALECT, rules: [synthRule] });
  return registry;
}

describe("detectDialect (§2)", () => {
  it("beta-shaped sample detects as beta (single-dialect default, §2.3)", () => {
    const detection = detectDialect(betaSample(), createDefaultDialectRegistry());
    expect(detection.dialectId).toBe(DIALECT_EQL_BETA_2026_07);
    expect(detection.viaMarker).toBe(false);
    expect(detection.confidence).toBeGreaterThan(0.99);
  });

  it("single registered dialect is returned even for garbage (zero behavior change)", () => {
    const garbage = Array.from({ length: 50 }, (_, i) => `[Fri Jul 10 17:14:01 2026] junk ${i} xyz`);
    const detection = detectDialect(garbage, createDefaultDialectRegistry());
    expect(detection.dialectId).toBe(DIALECT_EQL_BETA_2026_07);
    // Honest low confidence, but never "unknown" with one dialect registered.
    expect(detection.confidence).toBeLessThan(0.1);
  });

  it("multi-dialect best-match picks the lowest unmatched rate", () => {
    const detection = detectDialect(betaSample(), otherDialectRegistry());
    expect(detection.dialectId).toBe(DIALECT_EQL_BETA_2026_07);
    expect(detection.perDialectUnmatchedRate[DIALECT_EQL_BETA_2026_07]).toBeCloseTo(0, 10);
    expect(detection.perDialectUnmatchedRate[OTHER_DIALECT]).toBeGreaterThan(0.9);
  });

  it("a drifted sample matching no dialect well -> unknown, low confidence (§2.2)", () => {
    const drifted = driftFamilies(betaSample(), ["melee_hit", "heal", "chat_message"]);
    const detection = detectDialect(drifted, otherDialectRegistry());
    expect(detection.dialectId).toBe(UNKNOWN_DIALECT);
    expect(detection.confidence).toBe(0);
    // Best (beta) still exceeds the 5% alert threshold.
    expect(detection.perDialectUnmatchedRate[DIALECT_EQL_BETA_2026_07]).toBeGreaterThan(0.05);
  });

  it("a tie between two equally-good dialects -> unknown", () => {
    const registry = createDefaultDialectRegistry();
    // A second dialect with the SAME beta rules under a different id: equal rates.
    registry.register({ id: "eql-beta-twin-test", rules: allRules() });
    const detection = detectDialect(betaSample(), registry);
    expect(detection.dialectId).toBe(UNKNOWN_DIALECT);
  });

  it("explicit-marker hook, when it fires, wins with full confidence (§2.1)", () => {
    const detection = detectDialect(betaSample(), otherDialectRegistry(), {
      markerDetector: () => OTHER_DIALECT,
    });
    expect(detection.dialectId).toBe(OTHER_DIALECT);
    expect(detection.viaMarker).toBe(true);
    expect(detection.confidence).toBe(1);
  });

  it("the built-in marker stub is UNVERIFIED and never claims a match", () => {
    expect(detectExplicitMarker(betaSample(), createDefaultDialectRegistry())).toBeNull();
  });
});

describe("sampleForDetection (§2.2)", () => {
  it("returns the whole set when under the cap, deterministically", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    expect(sampleForDetection(lines)).toEqual(lines);
  });

  it("bounds a large set to maxLines and is deterministic (head + strided tail)", () => {
    const lines = Array.from({ length: 20000 }, (_, i) => `line ${i}`);
    const a = sampleForDetection(lines, { headLines: 100, maxLines: 500 });
    const b = sampleForDetection(lines, { headLines: 100, maxLines: 500 });
    expect(a.length).toBeLessThanOrEqual(500);
    expect(a).toEqual(b);
    expect(a.slice(0, 100)).toEqual(lines.slice(0, 100));
  });
});
