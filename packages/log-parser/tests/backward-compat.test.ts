/**
 * Backward-compatibility guarantee (LAUNCH_DIALECT_READINESS.md §6).
 *
 * The dialect machinery is strictly additive: beta stays the default and the
 * existing single-dialect parse path is UNCHANGED. This test proves it two ways
 * over the whole fixture set:
 *   1. the untouched `LogParser` output is byte-identical to the committed
 *      goldens (JSON-serialized), i.e. identical to before this ticket;
 *   2. parsing beta *through the new DialectRegistry* yields events identical to
 *      the default `LogParser`, so the registry reuses beta rules with zero
 *      behavior change.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import type { LogEvent } from "@eqlcc/event-schema";
import { DIALECT_EQL_BETA_2026_07 } from "@eqlcc/event-schema";

import { LogParser, createDefaultDialectRegistry } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "..", "..", "..", "tests", "fixtures", "eql-beta-2026-07");
const goldensDir = path.join(here, "goldens");

const fixtureFiles = fs
  .readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".txt"))
  .sort();

function readFixture(file: string): string {
  return fs.readFileSync(path.join(fixturesDir, file), "latin1");
}

describe("backward compatibility (§6)", () => {
  it("default LogParser output is byte-identical to the committed goldens", () => {
    for (const file of fixtureFiles) {
      const events = new LogParser({ logFileId: 1 }).parseText(readFixture(file));
      const golden = JSON.parse(
        fs.readFileSync(path.join(goldensDir, file.replace(/\.txt$/, ".json")), "utf8"),
      ) as { events: LogEvent[] };
      // Serialized equality == byte-identical parser output.
      expect(JSON.stringify(events)).toBe(JSON.stringify(golden.events));
    }
  });

  it("parsing beta through the DialectRegistry equals the default parser exactly", () => {
    const registry = createDefaultDialectRegistry();
    const recognizer = registry.recognizerFor(DIALECT_EQL_BETA_2026_07);
    expect(recognizer).toBeDefined();
    for (const file of fixtureFiles) {
      const text = readFixture(file);
      const viaDefault = new LogParser({ logFileId: 1 }).parseText(text);
      const viaRegistry = new LogParser({
        logFileId: 1,
        ...(recognizer !== undefined ? { registry: recognizer } : {}),
      }).parseText(text);
      expect(viaRegistry).toEqual(viaDefault);
    }
  });
});
