/**
 * Attribution honesty (docs/PROJECTIONS_SPEC.md §9.5): a pet's damage folds to
 * its owner ONLY with an active resolver link, and a user `entity_override`
 * reclassifying the pet removes the fold on the next rebuild.
 */

import { describe, expect, it } from "vitest";

import { getActorStats, rebuildProjections } from "../src/index.js";
import { groupFightScenario } from "./fixtures.js";
import { freshDb, insertEvents, snapshot } from "./support.js";

function petRow(db: ReturnType<typeof freshDb>["db"], petId: number) {
  const rows = (snapshot(db).encounter_actor_stats ?? []) as {
    entity_id: number;
    attrib_owner_id: number | null;
    damage_total: number;
  }[];
  return rows.find((r) => r.entity_id === petId);
}

describe("attribution honesty", () => {
  it("folds a pet to its owner with an active link, and unfolds on override", () => {
    const { db } = freshDb();
    insertEvents(db, groupFightScenario().events);
    rebuildProjections(db);

    const pet = db.prepare("SELECT id FROM entities WHERE canonical_name = 'Petone'").get() as {
      id: number;
    };
    const owner = db.prepare("SELECT id FROM entities WHERE canonical_name = 'Playerone'").get() as {
      id: number;
    };

    // With the pet_chatter link active, Petone's damage rolls up to the owner.
    expect(petRow(db, pet.id)?.attrib_owner_id).toBe(owner.id);
    const linkCount = (db.prepare("SELECT COUNT(*) AS c FROM entity_links").get() as { c: number }).c;
    expect(linkCount).toBe(1);

    // Owner-folded actor stats include the pet's damage under the owner.
    const foldedBefore = getActorStats(db, { encounterId: 1, foldPets: true });
    const ownerFolded = foldedBefore.rows.find((r) => r.entityId === owner.id);
    expect(ownerFolded?.damageTotal).toBe(17); // 13 (owner) + 4 (pet)
    expect(foldedBefore.provenance.minConfidence).toBeCloseTo(0.95); // pet-link confidence

    // User reclassifies Petone as a player (not our pet) → the fold must vanish.
    db.prepare(
      "INSERT INTO entity_overrides (entity_id, field, new_value, created_at) VALUES (?, 'kind', 'player', 0)",
    ).run(pet.id);
    rebuildProjections(db);

    const after = petRow(db, pet.id);
    expect(after?.attrib_owner_id).toBeNull(); // fold removed
    expect(after?.damage_total).toBe(4); // pet keeps its own damage, self-credited
    const linkAfter = (db.prepare("SELECT COUNT(*) AS c FROM entity_links WHERE active = 1").get() as {
      c: number;
    }).c;
    expect(linkAfter).toBe(0); // no active pet→owner link survives the override

    const foldedAfter = getActorStats(db, { encounterId: 1, foldPets: true });
    expect(foldedAfter.rows.find((r) => r.entityId === owner.id)?.damageTotal).toBe(13);
    expect(foldedAfter.provenance.minConfidence).toBe(1); // nothing rests on a heuristic now
  });
});
