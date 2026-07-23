/**
 * Named-enemy attribution (review MAJOR 2 + 3). Once an encounter has a known
 * enemy, that enemy identity drives BOTH attach and ally/enemy classification —
 * never re-derived from resolver kind alone:
 *  - a named enemy's own damage/heals are NEVER booked as ally actor-stats
 *    (MAJOR 2), even though the resolver leaves a proper name `unknown`;
 *  - later ally combat against the already-open named target attaches to the one
 *    encounter instead of being dropped as ambiguous (MAJOR 3).
 * Determinism + incremental == rebuild must still hold.
 */

import { describe, expect, it } from "vitest";

import {
  getActorStats,
  getEncounter,
  listEncounters,
  rebuildProjections,
  updateProjections,
} from "../src/index.js";
import { Scenario, melee, zoneEnter } from "./fixtures.js";
import { freshDb, insertEvents, snapshotJson } from "./support.js";

const SECOND = 1000;

/** Owner + two allies fight a named boss that also hits back. */
function namedBossScenario(): Scenario {
  const s = new Scenario();
  s.add(0, zoneEnter("Karnor's Castle"));
  s.add(SECOND, melee("You", "Venril Sathir", 10)); // opens the named encounter
  s.add(SECOND, melee("Playera", "Venril Sathir", 20)); // both unknown → attach (ally)
  s.add(SECOND, melee("Playerb", "Venril Sathir", 30)); // both unknown → attach (ally)
  s.add(SECOND, melee("Venril Sathir", "You", 5)); // enemy hits owner
  s.add(SECOND, melee("Venril Sathir", "Playera", 5)); // enemy hits ally (both unknown)
  s.add(SECOND, melee("You", "Venril Sathir", 10)); // attach, extends the window
  return s;
}

function build(): ReturnType<typeof freshDb>["db"] {
  const { db } = freshDb();
  insertEvents(db, namedBossScenario().events);
  rebuildProjections(db);
  return db;
}

describe("named-enemy attribution", () => {
  it("keeps all ally combat in one encounter and excludes the enemy's damage", () => {
    const db = build();

    const encs = listEncounters(db);
    expect(encs.length).toBe(1); // MAJOR 3: no dropped/duplicated encounters
    expect(encs[0]!.name).toBe("Venril Sathir");

    const venril = db.prepare("SELECT id FROM entities WHERE canonical_name = 'Venril Sathir'").get() as {
      id: number;
    };

    // MAJOR 2: the enemy has NO actor-stats row — its 10 damage is not booked.
    const enemyStat = db
      .prepare("SELECT COUNT(*) AS c FROM encounter_actor_stats WHERE entity_id = ?")
      .get(venril.id) as { c: number };
    expect(enemyStat.c).toBe(0);

    // All three allies attached to the one encounter, each with their own damage.
    const detail = getEncounter(db, encs[0]!.id)!;
    const byName = new Map(detail.actors.rows.map((r) => [r.entityName, r.damageTotal]));
    expect(byName.get("Playerone")).toBe(20); // You: 10 + 10
    expect(byName.get("Playera")).toBe(20);
    expect(byName.get("Playerb")).toBe(30);
    expect([...byName.keys()]).not.toContain("Venril Sathir");

    // Participants: 3 allies + 1 enemy.
    const roles = detail.participants.map((p) => `${p.entityName}:${p.role}`).sort();
    expect(roles).toEqual([
      "Playera:ally",
      "Playerb:ally",
      "Playerone:ally",
      "Venril Sathir:enemy",
    ]);

    // Folded top actor is an ally, never the enemy.
    const folded = getActorStats(db, { encounterId: encs[0]!.id, foldPets: true });
    expect(folded.rows.every((r) => r.entityName !== "Venril Sathir")).toBe(true);
  });

  it("is deterministic and incremental == rebuild for the named boss fight", () => {
    // determinism: two independent rebuilds are byte-identical.
    expect(snapshotJson(build())).toBe(snapshotJson(build()));

    // incremental == rebuild: one event at a time equals a single rebuild.
    const events = namedBossScenario().events;
    const inc = freshDb().db;
    for (const e of events) {
      insertEvents(inc, [e]);
      updateProjections(inc);
    }
    expect(snapshotJson(inc)).toBe(snapshotJson(build()));
  });
});
