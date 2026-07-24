/**
 * Rebuild perf regression guard (E1.3 / issue #21).
 *
 * The projection rebuild used to be ~O(n^1.8): two per-event "latest rare-field
 * value at/before id" lookups (actor-stats stance/invocation, domain level) each
 * scanned the whole single-file `events` table, so a 242k-line log took ~563s to
 * rebuild while parse/replay was ~8s. Those lookups are now advanced as in-memory
 * pass state, making rebuild ~linear.
 *
 * This guard rebuilds a sizable synthetic corpus at n and 2n and asserts the time
 * ratio stays near-linear. The threshold is deliberately generous (linear ≈ 2.0;
 * the old superlinear cost gave ≈ 3.7 at these sizes) so normal CI timing noise
 * can't flake it, while a reintroduced full-table scan (ratio → 3.5+) trips it.
 * It also re-verifies determinism and incremental == rebuild on the SAME corpus,
 * which exercises the resumed-active-encounter start-state reconstruction the fix
 * relies on — a pure-timing test could pass while silently corrupting outputs.
 */

import { describe, expect, it } from "vitest";

import { rebuildProjections, updateProjections } from "../src/index.js";
import { syntheticCombatScenario } from "./fixtures.js";
import { freshDb, insertEvents, snapshotJson } from "./support.js";

function timeRebuild(events: ReturnType<typeof syntheticCombatScenario>["events"]): number {
  const { db } = freshDb();
  insertEvents(db, events);
  const t0 = performance.now();
  rebuildProjections(db);
  const dt = performance.now() - t0;
  db.close();
  return dt;
}

/** Best-of-`runs` wall time, to damp scheduling / GC noise. */
function bestRebuildMs(target: number, seed: number, runs = 2): number {
  const events = syntheticCombatScenario(target, seed).events;
  let best = Infinity;
  for (let i = 0; i < runs; i++) best = Math.min(best, timeRebuild(events));
  return best;
}

describe("rebuild perf scaling (E1.3 / issue #21)", () => {
  it("scales roughly linearly: time(2n)/time(n) stays below the guard threshold", () => {
    const n = 8_000;
    // Warm up JIT / prepared-statement caches so the first size isn't penalized.
    void bestRebuildMs(2_000, 99, 1);

    const tN = bestRebuildMs(n, 1);
    const t2N = bestRebuildMs(2 * n, 1);
    const ratio = t2N / Math.max(tN, 1);

    // Linear ≈ 2.0; O(n^1.8) ≈ 3.5+. 3.0 cleanly separates the two with margin.
    expect(ratio).toBeLessThan(3.0);
  }, 60_000);

  it("stays deterministic and incremental == rebuild on the synthetic corpus", () => {
    const events = syntheticCombatScenario(6_000, 5).events;

    const rebuilt = (() => {
      const { db } = freshDb();
      insertEvents(db, events);
      rebuildProjections(db);
      return snapshotJson(db);
    })();

    // Determinism: a second independent rebuild is byte-identical.
    const rebuiltAgain = (() => {
      const { db } = freshDb();
      insertEvents(db, events);
      rebuildProjections(db);
      return snapshotJson(db);
    })();
    expect(rebuiltAgain).toBe(rebuilt);

    // Incremental in small, uneven chunks (many pass boundaries land mid-encounter,
    // forcing resumed-active-encounter start-state reconstruction) == rebuild.
    const incremental = (() => {
      const { db } = freshDb();
      for (let i = 0; i < events.length; i += 137) {
        insertEvents(db, events.slice(i, i + 137));
        updateProjections(db);
      }
      return snapshotJson(db);
    })();
    expect(incremental).toBe(rebuilt);
  }, 30_000);
});
