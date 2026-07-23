/**
 * Tunable derivation constants (docs/PROJECTIONS_SPEC.md §3–§7).
 *
 * Every segmentation / attribution threshold the spec names is exported here
 * with its documented default, so a caller can override behaviour without
 * forking the projectors. Constants are grouped into one resolved
 * {@link ProjectionOptions} object threaded through the driver and every
 * projector; {@link resolveOptions} fills any omitted field from
 * {@link DEFAULT_PROJECTION_OPTIONS}.
 *
 * Money is integer copper, percentages integer milli-percent; the only float is
 * `confidence` (0–1). No option here introduces a float into domain data.
 */

/** Idle timeout (ms) before an encounter of a given scale closes (spec §5). */
export interface EncounterTimeouts {
  /** Group-scale idle timeout. Default 15 s. */
  group: number;
  /** Raid-scale idle timeout. Default 2 min. */
  raid: number;
}

export interface ProjectionOptions {
  /**
   * Session close gap (spec §3): a gap between consecutive event `ts` greater
   * than this closes the session. Default 30 min.
   */
  sessionGapMs: number;
  /** Per-scale encounter idle timeouts (spec §5). */
  encounterTimeouts: EncounterTimeouts;
  /**
   * Distinct ally participant count above which an encounter escalates
   * `group` → `raid` (spec §5, RAID_ALLY_THRESHOLD). Default 6.
   */
  raidAllyThreshold: number;
  /**
   * XP → kill attribution window (spec §7): an `xp_gain` attributes to the
   * nearest preceding `kill`'s encounter only within this many ms. Default 5 s.
   */
  xpKillWindowMs: number;
  /**
   * Minimum pet→owner link confidence for a pet's contribution to roll up to
   * its owner (spec §2). Mirrors the resolver's ATTRIBUTION_MIN_CONFIDENCE
   * (0.5); exposed so the two can be tuned together. Default 0.5.
   */
  attributionMinConfidence: number;
  /** Experiment bootstrap settings (spec §8 / EXPERIMENT_DESIGN.md). */
  experiment: ExperimentOptions;
  /**
   * Events processed per transaction (spec §1 "batched transactions for
   * throughput"). The watermark advances with the writes inside each such
   * transaction. Default 1000. Purely a throughput knob — it never changes the
   * result (incremental == rebuild holds for any batch size).
   */
  batchSize: number;
}

export interface ExperimentOptions {
  /** Bootstrap resample count. Default 1000. */
  resamples: number;
  /** Fixed RNG seed so a breakdown is deterministic/reproducible. Default 0x5eed. */
  seed: number;
  /** Two-sided CI width as integer milli-percent of the tails, e.g. 95% CI. Default 95. */
  ciPercent: number;
  /**
   * Minimum encounters (n) in a group before a winner may be declared
   * (EXPERIMENT_DESIGN.md "refuse to declare a winner below minimum n").
   * Default 8.
   */
  minN: number;
}

/** Documented defaults (spec §3–§8). */
export const DEFAULT_PROJECTION_OPTIONS: ProjectionOptions = Object.freeze({
  sessionGapMs: 30 * 60 * 1000,
  encounterTimeouts: Object.freeze({ group: 15 * 1000, raid: 2 * 60 * 1000 }),
  raidAllyThreshold: 6,
  xpKillWindowMs: 5 * 1000,
  attributionMinConfidence: 0.5,
  experiment: Object.freeze({ resamples: 1000, seed: 0x5eed, ciPercent: 95, minN: 8 }),
  batchSize: 1000,
}) as ProjectionOptions;

/** A caller-supplied partial override of {@link ProjectionOptions}. */
export type ProjectionOptionsInput = {
  [K in keyof ProjectionOptions]?: K extends "encounterTimeouts"
    ? Partial<EncounterTimeouts>
    : K extends "experiment"
      ? Partial<ExperimentOptions>
      : ProjectionOptions[K];
};

/** Fill any omitted field from {@link DEFAULT_PROJECTION_OPTIONS}. */
export function resolveOptions(input: ProjectionOptionsInput = {}): ProjectionOptions {
  const d = DEFAULT_PROJECTION_OPTIONS;
  return {
    sessionGapMs: input.sessionGapMs ?? d.sessionGapMs,
    encounterTimeouts: {
      group: input.encounterTimeouts?.group ?? d.encounterTimeouts.group,
      raid: input.encounterTimeouts?.raid ?? d.encounterTimeouts.raid,
    },
    raidAllyThreshold: input.raidAllyThreshold ?? d.raidAllyThreshold,
    xpKillWindowMs: input.xpKillWindowMs ?? d.xpKillWindowMs,
    attributionMinConfidence: input.attributionMinConfidence ?? d.attributionMinConfidence,
    experiment: {
      resamples: input.experiment?.resamples ?? d.experiment.resamples,
      seed: input.experiment?.seed ?? d.experiment.seed,
      ciPercent: input.experiment?.ciPercent ?? d.experiment.ciPercent,
      minN: input.experiment?.minN ?? d.experiment.minN,
    },
    batchSize: input.batchSize ?? d.batchSize,
  };
}
