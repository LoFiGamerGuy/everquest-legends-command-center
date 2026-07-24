/**
 * Per-dialect benchmark + line analysis (LAUNCH_DIALECT_READINESS.md §4).
 *
 * Pure functions over provided raw log lines — no filesystem, no real corpus.
 * `analyzeLines` is the shared aggregator (used by benchmark, detection, and
 * drift); `benchmark` is the CI-gate view of it: how well a dialect recognizes
 * a set of lines, per family.
 *
 * A "line" is a raw log line WITH its timestamp prefix, exactly as the parser
 * sees it. Timestamp slicing and recognition mirror LogParser.parseLine so the
 * unmatched rate here equals the parser's `raw_unknown` rate.
 */

import type { Dialect } from "./dialect.js";
import type { RecognizerRule } from "./rule.js";
import { RecognizerRegistry } from "./registry.js";
import { MESSAGE_OFFSET, parseTimestamp } from "./timestamp.js";
import { UnknownStats } from "./unknown-stats.js";
import type { UnknownShape } from "./unknown-stats.js";

/** Full analysis of a line set against one rule set. */
export interface RunStats {
  /** Total lines examined. */
  lines: number;
  /** Lines that fell through to `raw_unknown`. */
  unmatched: number;
  /** `unmatched / lines` (0 when `lines === 0`). */
  rate: number;
  /** Recognized family -> count (excludes unmatched). */
  perFamily: Readonly<Record<string, number>>;
  /** Top unknown shapes (normalized + anonymized), by frequency. */
  unknownShapes: UnknownShape[];
}

/** Benchmark gate view (LAUNCH_DIALECT_READINESS.md §4). */
export interface BenchmarkResult {
  lines: number;
  unmatched: number;
  rate: number;
  perFamily: Readonly<Record<string, number>>;
}

/** CI target: a registered dialect must clear this on its corpus/fixtures. */
export const BENCHMARK_MAX_UNMATCHED_RATE = 0.02;

/**
 * Run `lines` through `rules` and aggregate match health. A line whose
 * timestamp does not parse counts as unmatched (mirrors the parser's malformed
 * -> raw_unknown policy). `topShapes` bounds the retained unknown-shape list.
 */
export function analyzeLines(
  rules: readonly RecognizerRule[],
  lines: readonly string[],
  topShapes = 20,
): RunStats {
  const registry = new RecognizerRegistry([...rules]);
  const perFamily = new Map<string, number>();
  const unknown = new UnknownStats();
  let unmatched = 0;

  for (const [index, raw] of lines.entries()) {
    const ts = parseTimestamp(raw);
    if (ts === null) {
      unmatched += 1;
      unknown.add(raw, index + 1);
      continue;
    }
    const message = raw.slice(MESSAGE_OFFSET);
    const recognition = registry.recognize(message);
    if (recognition === null) {
      unmatched += 1;
      unknown.add(message, index + 1);
      continue;
    }
    const family = recognition.rule.family;
    perFamily.set(family, (perFamily.get(family) ?? 0) + 1);
  }

  const lineCount = lines.length;
  return {
    lines: lineCount,
    unmatched,
    rate: lineCount === 0 ? 0 : unmatched / lineCount,
    perFamily: Object.fromEntries(perFamily),
    unknownShapes: unknown.top(topShapes),
  };
}

/**
 * Benchmark a dialect over provided lines (LAUNCH_DIALECT_READINESS.md §4).
 * Pure; the caller supplies lines (fixtures in CI, private corpus locally).
 */
export function benchmark(dialect: Dialect, lines: readonly string[]): BenchmarkResult {
  const stats = analyzeLines(dialect.rules, lines);
  return {
    lines: stats.lines,
    unmatched: stats.unmatched,
    rate: stats.rate,
    perFamily: stats.perFamily,
  };
}
