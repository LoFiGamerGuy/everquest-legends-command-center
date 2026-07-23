/**
 * Experiment breakdown (docs/PROJECTIONS_SPEC.md §8, docs/EXPERIMENT_DESIGN.md).
 *
 * Groups encounters by an A/B dimension and reports, per group, the metric mean
 * with a bootstrap confidence interval over encounters (the resampling unit —
 * hits within an encounter are correlated, EXPERIMENT_DESIGN.md §"Statistical
 * notes"), the sample size n, and — honestly — refuses to name a winner below
 * the minimum n or when the top two groups' CIs overlap. The bootstrap uses a
 * fixed seeded RNG so a breakdown is deterministic/reproducible.
 */

import type { ProjectionOptionsInput } from "../options.js";
import { resolveOptions } from "../options.js";
import type { Db } from "../projectors/types.js";
import type {
  ExperimentBreakdown,
  ExperimentDimension,
  ExperimentGroup,
  ExperimentMetric,
} from "./types.js";

interface EncounterMetricRow {
  id: number;
  zone_name: string | null;
  difficulty_tier: string | null;
  dur: number;
  dmg: number;
  heal: number;
  stance: string | null;
  invocation: string | null;
  xp: number;
}

export interface ExperimentQuery {
  dimension: ExperimentDimension;
  metric: ExperimentMetric;
}

export function getExperimentBreakdown(
  db: Db,
  query: ExperimentQuery,
  optionsInput: ProjectionOptionsInput = {},
): ExperimentBreakdown {
  const options = resolveOptions(optionsInput).experiment;

  if (query.dimension === "weapon") {
    // No verified in-log weapon/gear source in M1 (spec §10 open questions).
    return {
      dimension: query.dimension,
      metric: query.metric,
      minN: options.minN,
      groups: [],
      winner: null,
      winnerRefusedReason: "weapon dimension has no verified log source in M1",
    };
  }

  const rows = db
    .prepare(
      `SELECT en.id, z.name AS zone_name, en.difficulty_tier,
              (COALESCE(en.ended_ts, en.started_ts) - en.started_ts) AS dur,
              COALESCE((SELECT SUM(damage_total) FROM encounter_actor_stats WHERE encounter_id = en.id), 0) AS dmg,
              COALESCE((SELECT SUM(heal_total) FROM encounter_actor_stats WHERE encounter_id = en.id), 0) AS heal,
              (SELECT MIN(active_stance) FROM encounter_actor_stats WHERE encounter_id = en.id) AS stance,
              (SELECT MIN(active_invocation) FROM encounter_actor_stats WHERE encounter_id = en.id) AS invocation,
              COALESCE((SELECT SUM(percent_milli) FROM xp_events WHERE attributed_encounter_id = en.id AND kind = 'normal'), 0) AS xp
       FROM encounters en LEFT JOIN zones z ON z.id = en.zone_id
       ORDER BY en.id`,
    )
    .all() as EncounterMetricRow[];

  const buckets = new Map<string, number[]>();
  for (const r of rows) {
    const value = dimensionValue(query.dimension, r);
    if (value === null) continue;
    const metric = metricValue(query.metric, r);
    if (metric === null) continue;
    const arr = buckets.get(value) ?? [];
    arr.push(metric);
    buckets.set(value, arr);
  }

  // Seed the bootstrap RNG PER GROUP (from the fixed seed + the group value), so
  // a group's CI depends only on its own data — never on map-iteration / row
  // order — keeping the breakdown deterministic (a shared RNG stream would make
  // CIs order-dependent).
  const groups: ExperimentGroup[] = [...buckets.entries()]
    .map(([value, raw]) => {
      // Sort the group's samples so the bootstrap depends only on the multiset,
      // not on the encounters' insertion order → identical CI for the same input
      // regardless of how the underlying DB was built.
      const values = [...raw].sort((a, b) => a - b);
      const rng = mulberry32(groupSeed(options.seed, value));
      const ci = bootstrapCI(values, options.resamples, options.ciPercent, rng);
      return { value, n: values.length, mean: mean(values), ciLow: ci.low, ciHigh: ci.high };
    })
    .sort((a, b) => b.mean - a.mean || a.value.localeCompare(b.value));

  const { winner, reason } = pickWinner(groups, options.minN);
  return {
    dimension: query.dimension,
    metric: query.metric,
    minN: options.minN,
    groups,
    winner,
    winnerRefusedReason: reason,
  };
}

function dimensionValue(dimension: ExperimentDimension, r: EncounterMetricRow): string | null {
  switch (dimension) {
    case "stance":
      return r.stance;
    case "invocation":
      return r.invocation;
    case "zone":
      return r.zone_name ?? "Unknown Zone";
    case "difficulty":
      return r.difficulty_tier ?? "unknown";
    case "weapon":
      return null;
  }
}

function metricValue(metric: ExperimentMetric, r: EncounterMetricRow): number | null {
  if (r.dur <= 0) return null;
  switch (metric) {
    case "dps":
      return r.dmg / (r.dur / 1000);
    case "hps":
      return r.heal / (r.dur / 1000);
    case "xp_per_hr":
      return r.xp / (r.dur / 3_600_000);
  }
}

function pickWinner(
  groups: ExperimentGroup[],
  minN: number,
): { winner: { value: string; mean: number } | null; reason: string | null } {
  // `groups` is sorted by mean desc: groups[0] is the TOP OBSERVED candidate.
  // Refuse if IT lacks minimum n — never fall through to a lower-mean group that
  // happens to have more samples (that would not be "refuse below minimum n").
  const top = groups[0];
  if (top === undefined) return { winner: null, reason: "no groups to compare" };
  if (top.n < minN) {
    return {
      winner: null,
      reason: `top group '${top.value}' has n=${top.n}, below the minimum n (${minN})`,
    };
  }
  const runnerUp = groups[1];
  if (runnerUp !== undefined && top.ciLow <= runnerUp.ciHigh) {
    return { winner: null, reason: "top groups' confidence intervals overlap" };
  }
  return { winner: { value: top.value, mean: top.mean }, reason: null };
}

// ── Stats primitives ─────────────────────────────────────────────────────────

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Percentile CI of the resampled mean (bootstrap over the encounter values). */
function bootstrapCI(
  values: number[],
  resamples: number,
  ciPercent: number,
  rng: () => number,
): { low: number; high: number } {
  const n = values.length;
  if (n === 0) return { low: 0, high: 0 };
  if (n === 1) return { low: values[0] as number, high: values[0] as number };
  const means: number[] = [];
  for (let b = 0; b < resamples; b += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += values[Math.floor(rng() * n)] as number;
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const tail = (100 - ciPercent) / 2 / 100;
  return {
    low: percentile(means, tail),
    high: percentile(means, 1 - tail),
  };
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx] as number;
}

/** Fold a group value into the base seed (FNV-1a) → a stable per-group seed. */
function groupSeed(seed: number, value: string): number {
  let h = (seed ^ 0x811c9dc5) >>> 0;
  for (let i = 0; i < value.length; i += 1) {
    h = Math.imul(h ^ value.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic 32-bit PRNG (mulberry32) — reproducible bootstrap. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
