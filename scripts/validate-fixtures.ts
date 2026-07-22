#!/usr/bin/env node
/**
 * Fixture policy gate (CONTRIBUTING.md): scans tests/fixtures for
 *  - forbidden real names (list in tests/fixtures/.forbidden-names, one per line, NOT committed with real names in code)
 *  - lines not matching the EQL timestamp shape
 * Exits 1 on violation. Runs in CI.
 */
const fs = require("node:fs"); const path = require("node:path");
const root = path.join(__dirname, "..", "tests", "fixtures");
const forbiddenFile = path.join(root, ".forbidden-names");
const forbidden: string[] = fs.existsSync(forbiddenFile)
  ? fs.readFileSync(forbiddenFile, "utf8").split("\n").map((s: string) => s.trim()).filter(Boolean) : [];
const TS = /^\[(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ 0-9]\d \d\d:\d\d:\d\d \d{4}\] /;
let bad = 0;
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e: any) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
for (const f of walk(root).filter(f => f.endsWith(".txt"))) {
  const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
  lines.forEach((line: string, i: number) => {
    if (!TS.test(line)) { console.error(`${f}:${i + 1} bad timestamp shape`); bad++; }
    for (const name of forbidden) if (line.includes(name)) { console.error(`${f}:${i + 1} forbidden name`); bad++; }
  });
}
if (bad) { console.error(`${bad} fixture violations`); process.exit(1); }
console.log("fixtures OK");
