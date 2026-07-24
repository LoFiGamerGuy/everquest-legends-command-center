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
 * Launch-dialect modes (LAUNCH_DIALECT_READINESS.md §6):
 *   --detect   which registered dialect the log best matches (+ per-dialect rates)
 *   --drift    drift report vs the beta baseline; ANONYMIZED shape output only
 *              (never prints raw lines / player names)
 *
 * Reads files as latin1 so string offsets equal byte offsets (Windows-1252
 * logs; see line-reader.ts). Default-mode output is local diagnostics — raw
 * examples may contain player names; anonymize before sharing.
 */

import fs from "node:fs";

import type { LogEvent } from "@eqlcc/event-schema";
import { LogParser } from "./parser.js";
import { UnknownStats } from "./unknown-stats.js";
import { MESSAGE_OFFSET } from "./timestamp.js";
import { splitLines } from "./line-reader.js";
import { createDefaultDialectRegistry } from "./dialect.js";
import { BETA_BASELINE } from "./baselines/eql-beta-2026-07.js";
import { detectDialect, sampleForDetection, UNKNOWN_DIALECT } from "./detect.js";
import { analyzeLines, benchmark } from "./benchmark.js";
import { driftReport } from "./drift.js";

/** Read a log file's raw line strings (latin1; offsets == bytes). */
function readLines(path: string): string[] {
  return splitLines(fs.readFileSync(path, "latin1")).map((line) => line.raw);
}

function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

/** `--detect`: best-match dialect + per-dialect unmatched rates. */
function runDetect(paths: string[]): number {
  const registry = createDefaultDialectRegistry();
  const lines = paths.flatMap(readLines);
  const sample = sampleForDetection(lines);
  const detection = detectDialect(sample, registry);
  console.log("== dialect detection ==");
  console.log(`sampled lines: ${sample.length} (of ${lines.length})`);
  console.log(
    `detected: ${detection.dialectId}${
      detection.dialectId === UNKNOWN_DIALECT ? " (possible new dialect — flag for triage)" : ""
    }`,
  );
  console.log(`confidence: ${(detection.confidence * 100).toFixed(1)}%`);
  console.log(`via marker: ${detection.viaMarker}`);
  console.log("== per-dialect unmatched rate ==");
  for (const [id, rate] of Object.entries(detection.perDialectUnmatchedRate)) {
    console.log(`${String(formatPct(rate)).padStart(8)}  ${id}`);
  }
  return 0;
}

/** `--drift`: drift report vs the beta baseline. Anonymized shapes only. */
function runDrift(paths: string[], top: number): number {
  const registry = createDefaultDialectRegistry();
  const beta = registry.get(BETA_BASELINE.dialectId);
  if (beta === undefined) {
    console.error("beta dialect not registered");
    return 1;
  }
  const lines = paths.flatMap(readLines);
  const stats = analyzeLines(beta.rules, lines, top);
  const report = driftReport(stats, BETA_BASELINE, { topShapes: top });
  const bench = benchmark(beta, lines);
  console.log("== drift report (vs eql-beta-2026-07) ==");
  console.log(`lines: ${bench.lines}`);
  console.log(
    `overall unmatched: ${bench.unmatched} (${formatPct(report.overallUnmatchedRate)})` +
      `${report.overallUnmatchedFlag ? "  [FLAG: over threshold]" : ""}`,
  );
  console.log(`flagged: ${report.flagged}`);
  console.log("== dropped families (verified families whose share fell) ==");
  if (report.droppedFamilies.length === 0) {
    console.log("(none)");
  } else {
    for (const drift of report.droppedFamilies) {
      console.log(
        `${drift.family}: baseline ${formatPct(drift.baselineShare)} -> observed ` +
          `${formatPct(drift.observedShare)} (relative drop ${formatPct(drift.relativeDrop)})`,
      );
    }
  }
  console.log(`== top ${top} new unknown shapes (normalized + anonymized) ==`);
  for (const shape of report.newShapes) {
    // Shape only — normalizeShape has stripped names/numbers/quoted text.
    console.log(`${String(shape.count).padStart(7)}  ${shape.shape}`);
  }
  return 0;
}

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

type Mode = "triage" | "detect" | "drift";

function main(argv: string[]): number {
  const args: string[] = [];
  let top = 20;
  let mode: Mode = "triage";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--detect") {
      mode = "detect";
    } else if (arg === "--drift") {
      mode = "drift";
    } else if (arg === "--top") {
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
    console.error(
      "usage: eqlcc-parse <logfile> [more files...] [--top N] [--detect | --drift]",
    );
    return 2;
  }

  if (mode === "detect") return runDetect(args);
  if (mode === "drift") return runDrift(args, top);

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
