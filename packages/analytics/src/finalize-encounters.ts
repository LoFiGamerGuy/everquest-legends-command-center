/**
 * Optional terminal encounter close (docs/PROJECTIONS_SPEC.md §5/§8).
 *
 * Encounter closing is otherwise purely event-driven (an encounter closes only
 * when a later event proves the idle timeout elapsed), which is what makes
 * incremental == rebuild exact — so a finite event set legitimately leaves a
 * trailing still-`active` encounter. A caller that KNOWS a log is complete can
 * invoke this to close those trailing encounters. It is a deliberate terminal
 * action and is NOT part of the incremental == rebuild core: a later
 * `rebuildProjections` re-derives the trailing encounter as `active` again.
 */

import { resolveOptions, type ProjectionOptionsInput } from "./options.js";
import type { Db } from "./projectors/types.js";

export interface FinalizeEncountersResult {
  /** Number of encounters transitioned active → closed. */
  closed: number;
}

/**
 * Close still-`active` encounters. With `asOfTs`, closes only those whose idle
 * window has elapsed as of that time (`ended_ts + timeout(scale) < asOfTs`);
 * without it, closes ALL active encounters (treats the log as complete).
 */
export function finalizeEncounters(
  db: Db,
  asOfTs?: number,
  optsInput: ProjectionOptionsInput = {},
): FinalizeEncountersResult {
  const { encounterTimeouts } = resolveOptions(optsInput);
  const info =
    asOfTs === undefined
      ? db.prepare("UPDATE encounters SET status = 'closed' WHERE status = 'active'").run()
      : db
          .prepare(
            `UPDATE encounters SET status = 'closed'
             WHERE status = 'active'
               AND ended_ts + (CASE scale WHEN 'raid' THEN @raid ELSE @group END) < @asOf`,
          )
          .run({ raid: encounterTimeouts.raid, group: encounterTimeouts.group, asOf: asOfTs });
  return { closed: info.changes };
}
