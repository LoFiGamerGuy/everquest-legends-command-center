#!/usr/bin/env node
/**
 * Headless parse/triage CLI (issues #10/#11): parse EQL log file(s) and print
 * total lines, events by type, unmatched count/rate, and the top-20 unknown
 * shapes (shape-normalized, with first raw example).
 *
 * Usage:
 *   node packages/log-parser/dist/src/cli.js <logfile> [more files...] [--top N]
 *   npx tsx packages/log-parser/src/cli.ts <logfile> [--top N]
 *
 * Reads files as latin1 so string offsets equal byte offsets (Windows-1252
 * logs; see line-reader.ts). Output is local diagnostics — raw examples may
 * contain player names; anonymize before sharing.
 */

import fs from "node:fs";

import type { LogEvent } from "@eqlcc/event-schema";
import { LogParser } from "./parser.js";
import { UnknownStats } from "./unknown-stats.js";
import { MESSAGE_OFFSET } from "./timestamp.js";

interface FileReport {
  path: string;
  lines: number;
  events: number;
  unmatched: number;
}

function formatRate(unmatched: number, lines: number): string {
  if (lines === 0) return "0.00%";
  return `${((unmatched / lines) * 100).toFixed(2)}%`;
}

function main(argv: string[]): number {
  const args: string[] = [];
  let top = 20;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--top") {
      const value = argv[i + 1];
      if (value === undefined || !/^\d+$/.test(value)) {
        console.error("--top requires a number");
        return 2;
      }
      top = Number.parseInt(value, 10);
      i += 1;
    } else {
      args.push(arg);
    }
  }
  if (args.length === 0) {
    console.error("usage: eqlcc-parse <logfile> [more files...] [--top N]");
    return 2;
  }

  const typeCounts = new Map<string, number>();
  const unknownStats = new UnknownStats();
  const reports: FileReport[] = [];

  for (const [index, path] of args.entries()) {
    const text = fs.readFileSync(path, "latin1");
    const parser = new LogParser({ logFileId: index + 1 });
    const events: LogEvent[] = parser.parseText(text);
    let unmatched = 0;
    for (const event of events) {
      typeCounts.set(event.type, (typeCounts.get(event.type) ?? 0) + 1);
      if (event.type === "raw_unknown") {
        unmatched += 1;
        const message =
          event.raw.length > MESSAGE_OFFSET ? event.raw.slice(MESSAGE_OFFSET) : event.raw;
        unknownStats.add(message, event.lineNo);
      }
    }
    reports.push({ path, lines: events.length, events: events.length, unmatched });
  }

  const totalLines = reports.reduce((sum, r) => sum + r.lines, 0);
  const totalUnmatched = reports.reduce((sum, r) => sum + r.unmatched, 0);

  console.log("== per file ==");
  for (const report of reports) {
    console.log(
      `${report.path}\t lines=${report.lines}\t unmatched=${report.unmatched}\t rate=${formatRate(report.unmatched, report.lines)}`,
    );
  }
  console.log("== overall ==");
  console.log(`total lines: ${totalLines}`);
  console.log(`unmatched: ${totalUnmatched} (${formatRate(totalUnmatched, totalLines)})`);
  console.log(`distinct unknown shapes: ${unknownStats.distinctShapes}`);
  console.log("== events by type ==");
  const sortedTypes = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [type, count] of sortedTypes) {
    console.log(`${String(count).padStart(9)}  ${type}`);
  }
  console.log(`== top ${top} unknown shapes ==`);
  for (const shape of unknownStats.top(top)) {
    console.log(`${String(shape.count).padStart(7)}  ${shape.shape}`);
    console.log(`         e.g. ${shape.firstExample}`);
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
