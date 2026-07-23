/**
 * Watermark/entity same-transaction consistency (review MAJOR 1): the entities
 * projector's kind/link sync is committed IN THE SAME transaction as the batch
 * watermark advance, so a committed watermark always implies the entity + link
 * rows it derives (a crash between commits can never leave projectors at head
 * with entity/link rows missing). entity_links use a deterministic upsert, so
 * the link id never drifts across incremental passes.
 */

import { describe, expect, it } from "vitest";

import { updateProjections } from "../src/index.js";
import { groupFightScenario } from "./fixtures.js";
import { freshDb, insertEvents } from "./support.js";

describe("watermark ⇄ entity/link same-transaction consistency", () => {
  it("a committed watermark implies synced entity kinds and the pet link", () => {
    const events = groupFightScenario().events;
    const { db } = freshDb();
    // Ingest through the pet's combat (enough to establish the pet_chatter link).
    insertEvents(db, events.slice(0, 10));
    updateProjections(db);

    const entitiesWm = (
      db.prepare("SELECT last_event_id AS v FROM projection_state WHERE projector = 'entities'").get() as {
        v: number;
      }
    ).v;
    expect(entitiesWm).toBeGreaterThan(0); // watermark advanced

    // …and, in the same committed state, the pet's kind is synced (not the
    // 'unknown' placeholder) and its active owner link exists.
    const pet = db.prepare("SELECT kind, confidence FROM entities WHERE canonical_name = 'Petone'").get() as {
      kind: string;
      confidence: number;
    };
    expect(pet.kind).toBe("pet");
    expect(pet.confidence).toBeGreaterThan(0);
    const link = db
      .prepare("SELECT COUNT(*) AS c FROM entity_links WHERE active = 1")
      .get() as { c: number };
    expect(link.c).toBe(1);
  });

  it("entity_links id is stable across incremental passes (deterministic upsert)", () => {
    const events = groupFightScenario().events;
    const { db } = freshDb();
    // Establish the link in an early pass, then keep updating in small batches.
    for (const size of [5, 3, 4, 100]) {
      const before = db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number };
      insertEvents(db, events.slice(before.c, before.c + size));
      updateProjections(db);
    }
    const ids = (
      db.prepare("SELECT id FROM entity_links ORDER BY id").all() as { id: number }[]
    ).map((r) => r.id);
    // A single stable link with a stable id (never delete+reinserted to a new id).
    expect(ids).toEqual([1]);
  });
});
