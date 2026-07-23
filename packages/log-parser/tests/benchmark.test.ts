/**
 * Benchmark + analyzer math (LAUNCH_DIALECT_READINESS.md §4).
 *
 * Pure functions over SYNTHETIC lines with a valid timestamp prefix (so the
 * message slice mirrors the parser). No real corpus, no launch format.
 */

import { describe, expect, it } from "vitest";

import { analyzeLines, benchmark, regexRule } from "../src/index.js";
import type { Dialect, RecognizerRule } from "../src/index.js";

/** Prefix a synthetic message with a well-formed EQ timestamp (offset 27). */
const TS = "[Fri Jul 10 17:14:01 2026] ";
const line = (message: string): string => TS + message;

const okRule: RecognizerRule = regexRule({
  ruleId: "synth-ok",
  family: "ok",
  frequencyRank: 1,
  regex: /^OK (?<n>\d+)$/,
  build: () => ({ type: "system_message", kind: "ok" }),
});
const hiRule: RecognizerRule = regexRule({
  ruleId: "synth-hi",
  family: "hi",
  frequencyRank: 2,
  regex: /^HI$/,
  build: () => ({ type: "system_message", kind: "hi" }),
});

const dialect: Dialect = { id: "synth-bench", rules: [okRule, hiRule] };

describe("benchmark / analyzeLines (§4)", () => {
  it("computes lines, unmatched, rate, and perFamily", () => {
    const lines = [
      line("OK 1"),
      line("OK 2"),
      line("OK 3"),
      line("HI"),
      line("totally unrecognized body"),
    ];
    const result = benchmark(dialect, lines);
    expect(result.lines).toBe(5);
    expect(result.unmatched).toBe(1);
    expect(result.rate).toBeCloseTo(0.2, 10);
    expect(result.perFamily).toEqual({ ok: 3, hi: 1 });
  });

  it("counts a malformed-timestamp line as unmatched (parser parity)", () => {
    const lines = [line("OK 9"), "no timestamp here"];
    const result = benchmark(dialect, lines);
    expect(result.unmatched).toBe(1);
    expect(result.rate).toBeCloseTo(0.5, 10);
  });

  it("rate is 0 for an empty line set (no divide-by-zero)", () => {
    expect(benchmark(dialect, []).rate).toBe(0);
  });

  it("analyzeLines surfaces normalized+anonymized unknown shapes", () => {
    const stats = analyzeLines(dialect.rules, [line("weird 123 body"), line("weird 456 body")], 5);
    expect(stats.unmatched).toBe(2);
    // Digits normalized to '#', so both collapse to one shape.
    expect(stats.unknownShapes.length).toBe(1);
    expect(stats.unknownShapes[0]?.count).toBe(2);
    expect(stats.unknownShapes[0]?.shape).toContain("#");
  });
});
