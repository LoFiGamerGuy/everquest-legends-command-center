/**
 * Golden-file tests (ARCHITECTURE.md §6): replay every anonymized fixture in
 * tests/fixtures/eql-beta-2026-07 through the full parser and diff the typed
 * output against tests/goldens/<family>.json.
 *
 * Hard gates:
 *  - every fixture line outside raw-unknown.txt must be recognized (no silent
 *    fallthrough to raw_unknown);
 *  - every registry rule must be exercised by at least one fixture line
 *    (CONTRIBUTING.md fixture policy — a rule without a fixture doesn't merge);
 *  - every emitted event carries full provenance.
 *
 * Note on rune-absorb: the corpus never triggered a rune, so its fixture body
 * is the spec's own captured example (LOG_FORMAT_SPEC.md §4.8) with a
 * timestamp borrowed from the corpus session window.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { DIALECT_EQL_BETA_2026_07 } from "@eqlcc/event-schema";
import type { LogEvent } from "@eqlcc/event-schema";

import { LogParser, allRules } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "..", "..", "..", "tests", "fixtures", "eql-beta-2026-07");
const goldensDir = path.join(here, "goldens");

const fixtureFiles = fs
  .readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".txt"))
  .sort();

function parseFixture(file: string): LogEvent[] {
  const text = fs.readFileSync(path.join(fixturesDir, file), "latin1");
  const parser = new LogParser({ logFileId: 1 });
  return parser.parseText(text);
}

describe("fixture goldens (eql-beta-2026-07)", () => {
  it("has a golden for every fixture and vice versa", () => {
    const goldens = fs
      .readdirSync(goldensDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ".txt"))
      .sort();
    expect(goldens).toEqual(fixtureFiles);
  });

  for (const file of fixtureFiles) {
    it(`replays ${file} to its golden`, () => {
      const events = parseFixture(file);
      const golden = JSON.parse(
        fs.readFileSync(path.join(goldensDir, file.replace(/\.txt$/, ".json")), "utf8"),
      ) as { events: LogEvent[] };
      expect(events).toEqual(golden.events);
    });
  }

  it("recognizes every fixture line outside raw-unknown.txt", () => {
    for (const file of fixtureFiles) {
      if (file === "raw-unknown.txt") continue;
      for (const event of parseFixture(file)) {
        expect(event.type, `unmatched line in ${file}: ${event.raw}`).not.toBe("raw_unknown");
      }
    }
  });

  it("keeps raw-unknown.txt lines as raw_unknown (nothing is invented)", () => {
    for (const event of parseFixture("raw-unknown.txt")) {
      expect(event.type).toBe("raw_unknown");
      expect(event.ruleId).toBeNull();
    }
  });

  it("exercises every registry rule at least once (fixture policy hard gate)", () => {
    const covered = new Set<string>();
    for (const file of fixtureFiles) {
      for (const event of parseFixture(file)) {
        if (event.ruleId !== null) covered.add(event.ruleId);
      }
    }
    const missing = allRules()
      .map((rule) => rule.ruleId)
      .filter((id) => !covered.has(id));
    expect(missing).toEqual([]);
  });

  it("stamps full provenance on every event", () => {
    for (const file of fixtureFiles) {
      let lastOffset = -1;
      let lastSeq = 0;
      for (const event of parseFixture(file)) {
        expect(event.raw.length).toBeGreaterThan(0);
        expect(event.byteOffset).toBeGreaterThan(lastOffset);
        lastOffset = event.byteOffset;
        // (logFileId, seq) is the canonical total order: strictly monotonic.
        expect(event.seq).toBe(lastSeq + 1);
        lastSeq = event.seq;
        expect(event.lineNo).toBeGreaterThan(0);
        expect(event.logFileId).toBe(1);
        expect(event.dialectId).toBe(DIALECT_EQL_BETA_2026_07);
        expect(Number.isInteger(event.ts)).toBe(true);
        expect(event.ts).toBeGreaterThan(Date.UTC(2026, 6, 1));
      }
    }
  });
});
