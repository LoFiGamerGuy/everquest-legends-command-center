/**
 * Encounter segmentation (docs/PROJECTIONS_SPEC.md §9.6): group/raid timeout,
 * raid escalation, back-dated `ended_ts`, trash-vs-named naming, and
 * stance/invocation-at-start — on synthetic multi-actor fixtures.
 */

import { describe, expect, it } from "vitest";

import { listEncounters, rebuildProjections } from "../src/index.js";
import {
  Scenario,
  invocation,
  melee,
  stance,
  zoneEnter,
} from "./fixtures.js";
import { freshDb, insertEvents, snapshot } from "./support.js";

const SECOND = 1000;

function project(scenario: Scenario) {
  const { db } = freshDb();
  insertEvents(db, scenario.events);
  rebuildProjections(db);
  return db;
}

describe("encounter segmentation", () => {
  it("escalates to raid when distinct allies exceed the threshold", () => {
    const s = new Scenario();
    s.add(0, zoneEnter("Plane of Fear"));
    // 7 distinct (unknown) group members hit one mob → > RAID_ALLY_THRESHOLD (6).
    for (const name of ["Playera", "Playerb", "Playerc", "Playerd", "Playere", "Playerf", "Playerg"]) {
      s.add(SECOND, melee(name, "a fear golem", 10));
    }
    const db = project(s);
    const encs = listEncounters(db);
    expect(encs.length).toBe(1);
    expect(encs[0]!.scale).toBe("raid");
  });

  it("stays group scale below the threshold", () => {
    const s = new Scenario();
    s.add(0, zoneEnter("Plane of Fear"));
    for (const name of ["Playera", "Playerb"]) s.add(SECOND, melee(name, "a fear golem", 10));
    const db = project(s);
    expect(listEncounters(db)[0]!.scale).toBe("group");
  });

  it("closes a group encounter on the idle timeout and back-dates ended_ts", () => {
    const s = new Scenario();
    s.add(0, zoneEnter("The Northern Desert of Ro"));
    const first = s.add(SECOND, melee("You", "a sand rat", 5));
    const lastHit = s.add(3 * SECOND, melee("You", "a sand rat", 6)); // ended_ts should be here
    // 20 s later (> 15 s group timeout) a new mob → closes the rat encounter.
    s.add(20 * SECOND, melee("You", "a dune bat", 7));
    const db = project(s);

    const encs = listEncounters(db);
    expect(encs.length).toBe(2);
    const rat = encs[0]!;
    expect(rat.name).toBe("Trash: The Northern Desert of Ro");
    expect(rat.status).toBe("closed");
    expect(rat.startedTs).toBe(first.ts);
    // Back-dated to the last combat event, NOT the timeout expiry.
    expect(rat.endedTs).toBe(lastHit.ts);
    expect(encs[1]!.status).toBe("active"); // trailing encounter stays open
  });

  it("names a named enemy by its name and an article-led mob as Trash", () => {
    const s = new Scenario();
    s.add(0, zoneEnter("Karnor's Castle"));
    s.add(SECOND, melee("You", "Venril Sathir", 40)); // proper name → named
    s.add(30 * SECOND, melee("You", "a decaying skeleton", 5)); // article-led → trash
    const db = project(s);

    const encs = listEncounters(db);
    expect(encs.map((e) => e.name)).toEqual(["Venril Sathir", "Trash: Karnor's Castle"]);
  });

  it("records the owner's stance/invocation in effect at encounter start", () => {
    const s = new Scenario();
    s.add(0, zoneEnter("The Northern Desert of Ro"));
    s.add(SECOND, stance("berserker"));
    s.add(SECOND, invocation("recovery"));
    s.add(SECOND, melee("You", "a sand rat", 5)); // encounter opens here
    s.add(SECOND, stance("channeler")); // changed AFTER start — must not apply
    s.add(SECOND, melee("You", "a sand rat", 6));
    const db = project(s);

    const rows = snapshot(db).encounter_actor_stats as {
      active_stance: string | null;
      active_invocation: string | null;
    }[];
    expect(rows[0]!.active_stance).toBe("berserker");
    expect(rows[0]!.active_invocation).toBe("recovery");
  });
});
