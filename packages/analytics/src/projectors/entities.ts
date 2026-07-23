/**
 * Entities & entity_links projector (docs/PROJECTIONS_SPEC.md §2).
 *
 * `apply` guarantees an `entities` row (and stable id) exists for every named
 * participant, in first-seen order. `finalize` syncs the full final resolver
 * state — kind, confidence, classification source, first/last-seen, and the best
 * active pet→owner link — into `entities` / `entity_links`, so the tables are a
 * pure function of the resolver (which is itself a pure replay of events +
 * overrides). Ids are never re-assigned across rebuilds (the index preserves
 * them), which keeps overrides and historical FKs valid.
 */

import type { LogEvent } from "@eqlcc/event-schema";
import type { EntityRecord } from "@eqlcc/log-parser";

import type { PassContext, PassEvent, Projector } from "./types.js";

/** Raw participant names named by an event (before canonicalization). */
function namedParticipants(event: LogEvent): string[] {
  switch (event.type) {
    case "melee_hit":
    case "melee_miss":
    case "spell_damage":
      return [event.attacker, event.target];
    case "dot_tick":
      return event.attacker === null ? [event.target] : [event.attacker, event.target];
    case "damage_shield":
      return [event.owner, event.target];
    case "heal":
      return [event.healer, event.target];
    case "kill":
      return [event.killer, event.target];
    case "death":
      return event.killer === null ? [event.entity] : [event.entity, event.killer];
    default:
      return [];
  }
}

export function createEntitiesProjector(): Projector {
  return {
    name: "entities",
    version: 1,
    tablesOwned: ["entities", "entity_links"],

    load(ctx: PassContext): void {
      ctx.entities.load();
    },

    apply(ctx: PassContext, pe: PassEvent): void {
      for (const name of namedParticipants(pe.event)) {
        const canonical = ctx.resolver.resolve(name).canonical;
        ctx.entities.idFor(canonical);
      }
    },

    finalize(ctx: PassContext): void {
      const { db, resolver } = ctx;
      const upsertEntity = db.prepare(
        `UPDATE entities
           SET kind = @kind,
               classification_source = @source,
               confidence = @confidence,
               first_seen_ts = @firstSeen,
               last_seen_ts = @lastSeen
         WHERE id = @id`,
      );
      const clearLinks = db.prepare("DELETE FROM entity_links WHERE pet_entity_id = ?");
      const insertLink = db.prepare(
        `INSERT INTO entity_links
           (pet_entity_id, owner_entity_id, evidence_type, confidence,
            first_ts, last_ts, observation_count, active)
         VALUES (@pet, @owner, @evidence, @confidence, @firstTs, @lastTs, @count, @active)`,
      );

      for (const rec of resolver.list()) {
        // Ids are assigned ONLY during apply (event order); finalize updates
        // existing rows only, so id assignment is independent of finalize timing
        // (which runs every incremental pass) — keeping incremental == rebuild.
        const id = ctx.entities.peek(rec.canonical);
        if (id === undefined) continue;
        upsertEntity.run({
          id,
          kind: rec.kind,
          source: rec.classificationSource,
          confidence: rec.kindConfidence,
          firstSeen: rec.firstSeenTs ?? null,
          lastSeen: rec.lastSeenTs ?? null,
        });
        // Rewrite this pet's best link deterministically (idempotent).
        clearLinks.run(id);
        writeBestLink(rec, id, ctx, insertLink);
      }
    },

    reset(ctx: PassContext): void {
      // Entities rows are kept (ids are referenced by overrides and history and
      // are re-derived deterministically); only the rebuildable links are wiped.
      ctx.db.exec("DELETE FROM entity_links");
    },
  };
}

type InsertLinkStmt = ReturnType<PassContext["db"]["prepare"]>;

/**
 * Persist the resolver's single best pet→owner link for a record, when it holds
 * an active owner link. name_pattern-only pets never surface a link (the
 * resolver keeps `ownerLink` undefined for them), so nothing is written — a bare
 * name shape never becomes an owner fact (spec §2).
 */
function writeBestLink(
  rec: EntityRecord,
  petId: number,
  ctx: PassContext,
  insert: InsertLinkStmt,
): void {
  const link = rec.ownerLink;
  if (link === undefined || !link.active) return;
  const ownerId = ctx.entities.peek(link.ownerId);
  if (ownerId === undefined) return; // owner not observed in combat — no FK to reference
  const tss = link.evidence.map((e) => e.ts).filter((t): t is number => t !== undefined);
  const firstTs = tss.length > 0 ? Math.min(...tss) : (rec.firstSeenTs ?? 0);
  const lastTs = tss.length > 0 ? Math.max(...tss) : (rec.lastSeenTs ?? firstTs);
  insert.run({
    pet: petId,
    owner: ownerId,
    evidence: link.evidenceType,
    confidence: link.confidence,
    firstTs,
    lastTs,
    count: link.evidence.length,
    active: link.active ? 1 : 0,
  });
}
