/**
 * Determinism check (ARCHITECTURE.md §7): parse the fixture corpus twice —
 * stream-chunked at pseudo-random boundaries vs whole file — and require
 * identical event output. Seeded PRNG keeps the test itself deterministic.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LineSplitter, LogParser, splitLines } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "..", "..", "..", "tests", "fixtures", "eql-beta-2026-07");

/** Tiny deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("stream determinism", () => {
  it("chunked parsing equals whole-file parsing on every fixture", () => {
    const random = mulberry32(20260723);
    for (const file of fs.readdirSync(fixturesDir).filter((f) => f.endsWith(".txt"))) {
      const text = fs.readFileSync(path.join(fixturesDir, file), "latin1");

      const whole = new LogParser({ logFileId: 7 }).parseText(text);

      const chunkedParser = new LogParser({ logFileId: 7 });
      const splitter = new LineSplitter();
      const chunked = [];
      let pos = 0;
      while (pos < text.length) {
        const size = 1 + Math.floor(random() * 40);
        for (const line of splitter.feed(text.slice(pos, pos + size))) {
          chunked.push(chunkedParser.parseLine(line));
        }
        pos += size;
      }
      for (const line of splitter.end()) chunked.push(chunkedParser.parseLine(line));

      expect(chunked, file).toEqual(whole);
    }
  });

  it("splitLines byte offsets round-trip the file", () => {
    for (const file of fs.readdirSync(fixturesDir).filter((f) => f.endsWith(".txt"))) {
      const text = fs.readFileSync(path.join(fixturesDir, file), "latin1");
      for (const line of splitLines(text)) {
        expect(text.slice(line.byteOffset, line.byteOffset + line.raw.length)).toBe(line.raw);
      }
    }
  });
});
