/**
 * Test helper (not a suite): build a clean beta-shaped line sample and a
 * SYNTHETIC "drifted" variant from the committed beta fixtures.
 *
 * The drift is produced by rewriting the message body of lines belonging to a
 * chosen set of families to an obviously-synthetic, unrecognized wording. This
 * is a test INPUT standing in for hypothetical launch drift — it is never added
 * as a recognizer rule, fixture, or spec entry, so the never-fabricate-a-format
 * rule is respected.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RecognizerRegistry, MESSAGE_OFFSET, parseTimestamp } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "..", "..", "..", "tests", "fixtures", "eql-beta-2026-07");

/** All recognized beta lines (excludes the deliberate raw-unknown fixture). */
export function betaSample(): string[] {
  const lines: string[] = [];
  for (const file of fs.readdirSync(fixturesDir).filter((f) => f.endsWith(".txt")).sort()) {
    if (file === "raw-unknown.txt") continue;
    const text = fs.readFileSync(path.join(fixturesDir, file), "latin1");
    for (const raw of text.split(/\r?\n/)) {
      if (raw.length > 0) lines.push(raw);
    }
  }
  return lines;
}

/**
 * Rewrite the message body of every line whose beta family is in `families` to
 * a synthetic, unrecognized wording (keeping the timestamp prefix). Returns the
 * mutated line set; the listed families now fall to `raw_unknown`.
 */
export function driftFamilies(lines: readonly string[], families: readonly string[]): string[] {
  const targets = new Set(families);
  const registry = new RecognizerRegistry();
  return lines.map((raw) => {
    if (parseTimestamp(raw) === null) return raw;
    const recognition = registry.recognize(raw.slice(MESSAGE_OFFSET));
    if (recognition !== null && targets.has(recognition.rule.family)) {
      return `${raw.slice(0, MESSAGE_OFFSET)}the ${recognition.rule.family} wording drifted at launch`;
    }
    return raw;
  });
}
