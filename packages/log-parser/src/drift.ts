/**
 * Drift detection (LAUNCH_DIALECT_READINESS.md §3).
 *
 * Launch risk is *partial* drift: a few high-frequency families change wording
 * and silently fall to `raw_unknown` while the overall rate barely moves. So we
 * watch per-family match health against a committed `DialectBaseline`, not just
 * the overall rate.
 *
 * `driftReport(stats, baseline)` flags:
 *   (a) overall unmatched rate > DRIFT_ALERT_RATE;
 *   (b) any VERIFIED family (one present in the baseline) whose observed share
 *       of recognized lines drops by more than FAMILY_DROP_THRESHOLD (relative)
 *       — the signature of that family's wording changing;
 *   (c) the top new unknown shapes (already normalized + anonymized), ready to
 *       become launch fixtures.
 */

import type { DialectBaseline } from "./dialect.js";
import type { RunStats } from "./benchmark.js";
import type { UnknownShape } from "./unknown-stats.js";
import { DRIFT_ALERT_RATE } from "./detect.js";

/** Relative drop in a family's recognized-line share that flags drift (§3b). */
export const FAMILY_DROP_THRESHOLD = 0.5;

export interface FamilyDrift {
  family: string;
  /** Baseline share of recognized lines (from the dialect baseline). */
  baselineShare: number;
  /** Observed share of recognized lines in this run. */
  observedShare: number;
  /** Relative drop `(baseline - observed) / baseline`, in [0, 1]. */
  relativeDrop: number;
}

export interface DriftReport {
  /** Overall unmatched rate for the run (`stats.rate`). */
  overallUnmatchedRate: number;
  /** (a) overall rate exceeded the alert threshold. */
  overallUnmatchedFlag: boolean;
  /** (b) verified families whose share dropped past the threshold, worst first. */
  droppedFamilies: FamilyDrift[];
  /** (c) top new unknown shapes by frequency (normalized + anonymized). */
  newShapes: UnknownShape[];
  /** True if any flag fired — the run needs triage (§5 launch playbook). */
  flagged: boolean;
}

export interface DriftReportOptions {
  /** Overall-rate alert threshold (default DRIFT_ALERT_RATE). */
  driftAlertRate?: number;
  /** Relative family-share drop threshold (default FAMILY_DROP_THRESHOLD). */
  familyDropThreshold?: number;
  /** Max new unknown shapes to surface (default: all in `stats.unknownShapes`). */
  topShapes?: number;
}

/** Total recognized lines behind a per-family count map. */
function recognizedTotal(perFamily: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const count of Object.values(perFamily)) total += count;
  return total;
}

/**
 * Compare an observed run against a dialect baseline (§3). `stats` is the output
 * of `analyzeLines`/`benchmark` (plus unknown shapes); `baseline` is the
 * dialect's committed expected family distribution.
 */
export function driftReport(
  stats: RunStats,
  baseline: DialectBaseline,
  options: DriftReportOptions = {},
): DriftReport {
  const driftAlertRate = options.driftAlertRate ?? DRIFT_ALERT_RATE;
  const familyDropThreshold = options.familyDropThreshold ?? FAMILY_DROP_THRESHOLD;

  const observedTotal = recognizedTotal(stats.perFamily);
  const droppedFamilies: FamilyDrift[] = [];

  // (b) Only VERIFIED families — those the baseline knows — can "drop".
  for (const [family, baselineShare] of Object.entries(baseline.familyShares)) {
    if (baselineShare <= 0) continue;
    const observedCount = stats.perFamily[family] ?? 0;
    const observedShare = observedTotal === 0 ? 0 : observedCount / observedTotal;
    const relativeDrop = (baselineShare - observedShare) / baselineShare;
    if (relativeDrop > familyDropThreshold) {
      droppedFamilies.push({ family, baselineShare, observedShare, relativeDrop });
    }
  }
  droppedFamilies.sort((a, b) => b.relativeDrop - a.relativeDrop);

  // (c) New unknown shapes to promote to fixtures.
  const newShapes =
    options.topShapes === undefined
      ? [...stats.unknownShapes]
      : stats.unknownShapes.slice(0, options.topShapes);

  const overallUnmatchedFlag = stats.rate > driftAlertRate;

  return {
    overallUnmatchedRate: stats.rate,
    overallUnmatchedFlag,
    droppedFamilies,
    newShapes,
    flagged: overallUnmatchedFlag || droppedFamilies.length > 0,
  };
}
