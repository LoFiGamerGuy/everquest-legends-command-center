/**
 * Dialect detection (LAUNCH_DIALECT_READINESS.md §2).
 *
 * `detectDialect(sampleLines, registry)` answers "which registered dialect is
 * this log?" via:
 *   1. an explicit version/build marker if the client writes one (§2.1) — a
 *      clearly-marked HOOK/STUB here: the marker wire format is UNVERIFIED until
 *      launch, so the built-in detector returns null and the best-match path
 *      takes over. Callers/tests may inject a real detector via options once the
 *      format is confirmed;
 *   2. best-match fallback (§2.2, always available): run the sample through each
 *      dialect and pick the lowest unmatched rate. All-poor (> DRIFT_ALERT_RATE)
 *      or a tie -> `unknown`, so the caller flags "possible new dialect" rather
 *      than silently mis-parsing.
 *
 * A single registered dialect (today: beta) always returns that dialect — zero
 * behavior change (§2.3).
 */

import type { DialectId } from "@eqlcc/event-schema";

import type { DialectRegistry } from "./dialect.js";
import { benchmark } from "./benchmark.js";

/** Overall-unmatched threshold above which best-match yields `unknown` (§2/§3). */
export const DRIFT_ALERT_RATE = 0.05;

/** Sentinel dialect id returned when no registered dialect is a confident fit. */
export const UNKNOWN_DIALECT = "unknown";

/** Floating-point tie tolerance when comparing two dialects' unmatched rates. */
const TIE_EPSILON = 1e-9;

/**
 * Explicit-marker detector (§2.1). The launch client MAY write a build/version
 * line to the log; if so this is the cheapest, exact route. The exact wire
 * format is UNVERIFIED (see LAUNCH_DIALECT_READINESS.md §7 open questions), so
 * this built-in STUB never claims a match. Replace via
 * `DetectDialectOptions.markerDetector` once the format is confirmed at launch —
 * do NOT guess a format here (never-fabricate rule).
 */
export function detectExplicitMarker(
  sampleLines: readonly string[],
  registry: DialectRegistry,
): DialectId | null {
  // UNVERIFIED marker format: no parsing yet, so nothing is claimed. Params are
  // part of the stable hook signature (see DetectDialectOptions.markerDetector).
  void sampleLines;
  void registry;
  return null;
}

export interface DetectDialectOptions {
  /** Override the all-poor threshold (default DRIFT_ALERT_RATE). */
  driftAlertRate?: number;
  /**
   * Explicit-marker hook override (§2.1). Defaults to the UNVERIFIED stub.
   * Return a registered dialect id for an exact match, or null to fall through.
   */
  markerDetector?: (lines: readonly string[], registry: DialectRegistry) => DialectId | null;
}

export interface DialectDetection {
  /** Best-fit dialect id, or `UNKNOWN_DIALECT` when none is confident. */
  dialectId: DialectId;
  /** Confidence in `dialectId` in [0, 1]; 0 when `unknown`. */
  confidence: number;
  /** Measured unmatched rate per registered dialect (transparency). */
  perDialectUnmatchedRate: Readonly<Record<DialectId, number>>;
  /** True when an explicit marker (not best-match) decided this. */
  viaMarker: boolean;
}

/**
 * Detect the dialect of `sampleLines` against `registry`. Lines are raw log
 * lines (timestamp prefix included), e.g. a `sampleForDetection` slice.
 */
export function detectDialect(
  sampleLines: readonly string[],
  registry: DialectRegistry,
  options: DetectDialectOptions = {},
): DialectDetection {
  const driftAlertRate = options.driftAlertRate ?? DRIFT_ALERT_RATE;
  const markerDetector = options.markerDetector ?? detectExplicitMarker;

  // Intentional: measure every dialect's rate up front (cheap; single sample
  // pass each) so `perDialectUnmatchedRate` is always populated for transparency,
  // even when the explicit marker below short-circuits the selection.
  const perDialectUnmatchedRate: Record<DialectId, number> = {};
  for (const id of registry.ids()) {
    const dialect = registry.get(id);
    if (dialect === undefined) continue;
    perDialectUnmatchedRate[id] = benchmark(dialect, sampleLines).rate;
  }

  // 1. Explicit marker (preferred if present and points at a known dialect).
  const marked = markerDetector(sampleLines, registry);
  if (marked !== null && registry.has(marked)) {
    return {
      dialectId: marked,
      confidence: 1,
      perDialectUnmatchedRate,
      viaMarker: true,
    };
  }

  const ids = registry.ids();

  // 2c. Zero-dialect registry: nothing to match.
  if (ids.length === 0) {
    return { dialectId: UNKNOWN_DIALECT, confidence: 0, perDialectUnmatchedRate, viaMarker: false };
  }

  // 2.3. Single registered dialect -> that dialect, unconditionally (no change).
  if (ids.length === 1) {
    const only = ids[0] as DialectId;
    const rate = perDialectUnmatchedRate[only] ?? 0;
    return {
      dialectId: only,
      confidence: 1 - rate,
      perDialectUnmatchedRate,
      viaMarker: false,
    };
  }

  // 2.2. Best-match fallback: lowest unmatched rate wins.
  const ranked = ids
    .map((id) => ({ id, rate: perDialectUnmatchedRate[id] ?? 1 }))
    .sort((a, b) => a.rate - b.rate);
  const best = ranked[0];
  const second = ranked[1];
  if (best === undefined) {
    return { dialectId: UNKNOWN_DIALECT, confidence: 0, perDialectUnmatchedRate, viaMarker: false };
  }

  // All-poor: even the best exceeds the alert threshold -> possible new dialect.
  if (best.rate > driftAlertRate) {
    return { dialectId: UNKNOWN_DIALECT, confidence: 0, perDialectUnmatchedRate, viaMarker: false };
  }
  // Tie: two dialects fit equally well -> ambiguous, don't guess.
  if (second !== undefined && second.rate - best.rate < TIE_EPSILON) {
    return { dialectId: UNKNOWN_DIALECT, confidence: 0, perDialectUnmatchedRate, viaMarker: false };
  }

  return {
    dialectId: best.id,
    confidence: 1 - best.rate,
    perDialectUnmatchedRate,
    viaMarker: false,
  };
}

export interface SampleOptions {
  /** Always include the first `headLines` (default 1000). */
  headLines?: number;
  /** Cap the total sample at `maxLines` (default 5000). */
  maxLines?: number;
}

/**
 * Deterministically down-sample a large line array for detection (§2.2 "first +
 * a random slice, ~2–5k lines"). Takes the head verbatim, then an evenly-strided
 * slice of the remainder — deterministic (no RNG) so detection is reproducible.
 */
export function sampleForDetection(
  lines: readonly string[],
  options: SampleOptions = {},
): string[] {
  const headLines = options.headLines ?? 1000;
  const maxLines = options.maxLines ?? 5000;
  if (lines.length <= maxLines) return [...lines];

  const head = lines.slice(0, headLines);
  const remaining = maxLines - head.length;
  if (remaining <= 0) return head;

  const tail = lines.slice(headLines);
  const stride = Math.ceil(tail.length / remaining);
  const sampled: string[] = [];
  for (let i = 0; i < tail.length && sampled.length < remaining; i += stride) {
    sampled.push(tail[i] as string);
  }
  return [...head, ...sampled];
}
