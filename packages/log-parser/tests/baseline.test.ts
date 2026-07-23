/**
 * Beta baseline provenance guard (LAUNCH_DIALECT_READINESS.md §3).
 *
 * Re-derives the per-family recognized-line counts from the committed beta
 * fixtures and asserts they equal the committed `BETA_FAMILY_COUNTS`. This
 * proves the shipped baseline data is exactly what the fixtures produce — it can
 * never silently diverge — and documents how the baseline is generated.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { DIALECT_EQL_BETA_2026_07 } from "@eqlcc/event-schema";

import {
  BETA_BASELINE,
  BETA_FAMILY_COUNTS,
  RecognizerRegistry,
  MESSAGE_OFFSET,
  parseTimestamp,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "..", "..", "..", "tests", "fixtures", "eql-beta-2026-07");

function deriveCounts(): Record<string, number> {
  const registry = new RecognizerRegistry();
  const counts: Record<string, number> = {};
  for (const file of fs.readdirSync(fixturesDir).filter((f) => f.endsWith(".txt")).sort()) {
    const text = fs.readFileSync(path.join(fixturesDir, file), "latin1");
    for (const raw of text.split(/\r?\n/)) {
      if (raw.length === 0) continue;
      if (parseTimestamp(raw) === null) continue;
      const recognition = registry.recognize(raw.slice(MESSAGE_OFFSET));
      if (recognition === null) continue;
      const family = recognition.rule.family;
      counts[family] = (counts[family] ?? 0) + 1;
    }
  }
  return counts;
}

describe("BETA_BASELINE provenance (§3)", () => {
  it("committed family counts equal the fixture-derived counts", () => {
    expect(BETA_FAMILY_COUNTS).toEqual(deriveCounts());
  });

  it("familyShares are the normalized counts and sum to ~1", () => {
    const total = Object.values(BETA_FAMILY_COUNTS).reduce((a, b) => a + b, 0);
    const sum = Object.values(BETA_BASELINE.familyShares).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
    expect(BETA_BASELINE.familyShares.system_message).toBeCloseTo(
      (BETA_FAMILY_COUNTS.system_message ?? 0) / total,
      10,
    );
  });

  it("every verified family has a positive expected share, tagged to beta", () => {
    expect(BETA_BASELINE.dialectId).toBe(DIALECT_EQL_BETA_2026_07);
    for (const share of Object.values(BETA_BASELINE.familyShares)) {
      expect(share).toBeGreaterThan(0);
    }
  });
});
