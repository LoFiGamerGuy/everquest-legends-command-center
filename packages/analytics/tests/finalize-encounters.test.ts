/**
 * Optional terminal encounter close (review MAJOR 5): finalizeEncounters closes
 * a trailing still-active encounter for a completed log. It is NOT part of the
 * incremental == rebuild core — a later rebuild re-derives the trailing
 * encounter as active.
 */

import { describe, expect, it } from "vitest";

import { finalizeEncounters, listEncounters, rebuildProjections } from "../src/index.js";
import { groupFightScenario, Scenario, melee, zoneEnter } from "./fixtures.js";
import { freshDb, insertEvents } from "./support.js";

describe("finalizeEncounters", () => {
  it("closes a trailing still-active encounter, and a rebuild re-opens it", () => {
    const { db } = freshDb();
    insertEvents(db, groupFightScenario().events);
    rebuildProjections(db);

    const trailing = listEncounters(db).find((e) => e.status === "active");
    expect(trailing).toBeDefined(); // trailing active encounter is expected

    const { closed } = finalizeEncounters(db);
    expect(closed).toBe(1);
    expect(listEncounters(db).every((e) => e.status === "closed")).toBe(true);

    // Terminal close is not part of the core: a rebuild re-derives it as active.
    rebuildProjections(db);
    expect(listEncounters(db).some((e) => e.status === "active")).toBe(true);
  });

  it("with asOfTs, closes only encounters whose idle window has elapsed", () => {
    const s = new Scenario();
    s.add(0, zoneEnter("The Northern Desert of Ro"));
    const hit = s.add(1000, melee("You", "a sand rat", 5)); // opens; ended_ts = hit.ts
    const { db } = freshDb();
    insertEvents(db, s.events);
    rebuildProjections(db);
    expect(listEncounters(db)[0]!.status).toBe("active");

    // 10 s later is within the 15 s group window → not closed.
    expect(finalizeEncounters(db, hit.ts + 10_000).closed).toBe(0);
    expect(listEncounters(db)[0]!.status).toBe("active");

    // 20 s later is past the window → closed.
    expect(finalizeEncounters(db, hit.ts + 20_000).closed).toBe(1);
    expect(listEncounters(db)[0]!.status).toBe("closed");
  });
});
