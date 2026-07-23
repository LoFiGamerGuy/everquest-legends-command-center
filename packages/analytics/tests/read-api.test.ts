/**
 * Read/query API (docs/PROJECTIONS_SPEC.md §8): session analytics, economy
 * queries, damage-split rollups, and the experiment breakdown (bootstrap CI + n,
 * with the below-minimum-n refusal and deterministic seeded resampling).
 */

import { describe, expect, it } from "vitest";

import {
  getActorStats,
  getCurrency,
  getExperimentBreakdown,
  getFactionChanges,
  getLoot,
  getSessionSummary,
  getSessions,
  getXpRate,
  rebuildProjections,
} from "../src/index.js";
import {
  Scenario,
  damageShield,
  dot,
  melee,
  petChatter,
  stance,
  zoneEnter,
} from "./fixtures.js";
import { groupFightScenario } from "./fixtures.js";
import { freshDb, insertEvents } from "./support.js";

const SECOND = 1000;

describe("read API — session analytics & economy", () => {
  const { db } = freshDb();
  insertEvents(db, groupFightScenario().events);
  rebuildProjections(db);
  const session1 = getSessions(db)[0]!.id;

  it("summarizes active/afk ms, xp/hr and coin/hr", () => {
    const summary = getSessionSummary(db, session1)!;
    expect(summary.spanMs).toBe(13_000);
    expect(summary.activeMs).toBe(5_000); // one encounter, span 5 s
    expect(summary.afkMs).toBe(8_000);
    expect(summary.encounterCount).toBe(1);
    expect(summary.xpPercentMilli).toBe(1019);
    expect(summary.coinCopper).toBe(18);
    expect(summary.zones).toEqual(["The Northern Desert of Ro"]);
    expect(summary.xpPerHour).toBeCloseTo(1019 / (13_000 / 3_600_000));
  });

  it("reports xp rate with kill attribution", () => {
    const rate = getXpRate(db, session1);
    expect(rate.totalPercentMilli).toBe(1019);
    expect(rate.attributedPercentMilli).toBe(1019);
    expect(rate.killCount).toBe(1);
  });

  it("returns loot, currency and faction rows", () => {
    expect(getLoot(db).map((l) => l.mode)).toEqual(["auto_sold"]);
    expect(getCurrency(db).map((c) => [c.reason, c.deltaCopper])).toEqual([["auto_sell", 18]]);
    expect(getFactionChanges(db, session1).map((f) => [f.factionName, f.delta])).toEqual([
      ["New Sebilisian Expedition", 100],
    ]);
  });
});

describe("read API — damage splits with pet fold", () => {
  it("splits melee/spell/dot/ds and folds the pet's DS to the owner", () => {
    const s = new Scenario();
    s.add(0, zoneEnter("The Northern Desert of Ro"));
    s.add(SECOND, petChatter("Petone", "a mob"));
    s.add(SECOND, melee("You", "a mob", 5));
    s.add(SECOND, dot("You", "a mob", 10));
    s.add(SECOND, damageShield("Petone", "a mob", 6)); // pet DS → folds to owner
    const { db } = freshDb();
    insertEvents(db, s.events);
    rebuildProjections(db);

    const owner = db.prepare("SELECT id FROM entities WHERE canonical_name='Playerone'").get() as { id: number };
    const folded = getActorStats(db, { encounterId: 1, foldPets: true }).rows.find(
      (r) => r.entityId === owner.id,
    )!;
    expect(folded.meleeDamage).toBe(5);
    expect(folded.dotDamage).toBe(10);
    expect(folded.dsDamage).toBe(6); // pet's damage-shield folded in
    expect(folded.damageTotal).toBe(21);
  });
});

describe("read API — experiment breakdown", () => {
  /** Build `n` single-mob encounters at a given stance with a fixed per-hit damage. */
  function fights(s: Scenario, stanceName: string, hitDamage: number, count: number): void {
    for (let i = 0; i < count; i += 1) {
      s.add(20 * SECOND, stance(stanceName));
      s.add(SECOND, melee("You", "a training dummy", hitDamage));
      s.add(SECOND, melee("You", "a training dummy", hitDamage)); // 1 s span → dps = hitDamage
    }
  }

  function breakdownDb() {
    const s = new Scenario();
    s.add(0, zoneEnter("The Northern Desert of Ro"));
    fights(s, "berserker", 100, 4); // dps ≈ 200 (two 100-dmg hits over 1 s)
    fights(s, "channeler", 10, 4); // dps ≈ 20
    const { db } = freshDb();
    insertEvents(db, s.events);
    rebuildProjections(db);
    return db;
  }

  it("groups by stance with n and a bootstrap CI, and is deterministic", () => {
    const db = breakdownDb();
    const opts = { experiment: { minN: 3, resamples: 200 } };
    const a = getExperimentBreakdown(db, { dimension: "stance", metric: "dps" }, opts);
    const b = getExperimentBreakdown(db, { dimension: "stance", metric: "dps" }, opts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // seeded → reproducible

    expect(a.groups.map((g) => g.value).sort()).toEqual(["berserker", "channeler"]);
    for (const g of a.groups) {
      expect(g.n).toBe(4);
      expect(g.ciLow).toBeLessThanOrEqual(g.mean);
      expect(g.ciHigh).toBeGreaterThanOrEqual(g.mean);
    }
    // berserker clearly wins (non-overlapping CIs, n ≥ minN).
    expect(a.winner?.value).toBe("berserker");
  });

  it("refuses a winner below minimum n", () => {
    const db = breakdownDb();
    const strict = getExperimentBreakdown(db, { dimension: "stance", metric: "dps" }, { experiment: { minN: 10 } });
    expect(strict.winner).toBeNull();
    expect(strict.winnerRefusedReason).toMatch(/minimum n/);
  });

  it("reports weapon dimension as unsupported in M1", () => {
    const db = breakdownDb();
    const w = getExperimentBreakdown(db, { dimension: "weapon", metric: "dps" });
    expect(w.groups).toEqual([]);
    expect(w.winner).toBeNull();
    expect(w.winnerRefusedReason).toMatch(/weapon/);
  });
});
