/**
 * Projection driver (docs/PROJECTIONS_SPEC.md §1).
 *
 * Reads `events` in `(log_file_id, seq)` order starting at
 * `min(projection_state.last_event_id)+1` across the active projectors and, for
 * each event, advances every behind projector's watermark IN THE SAME
 * TRANSACTION as its writes (batched for throughput). A single resolver is
 * advanced alongside — every event is `observe`d before attribution — and on a
 * (re)build it is replayed from scratch with `entity_overrides` applied first,
 * so projections never depend on the orchestrator's persisted snapshot and stay
 * independently rebuildable (spec §1).
 *
 * `updateProjections` catches up to head; `rebuildProjections` wipes every
 * projector's output first. Because each projector reconstructs its working
 * state from already-written rows at pass start, an incremental catch-up in
 * arbitrary batches equals a single full rebuild (§9.2, the headline guarantee).
 */

import type { EntityKind, LogEvent } from "@eqlcc/event-schema";
import { EntityResolver } from "@eqlcc/log-parser";

import { EntityIndex } from "./entity-index.js";
import { resolveOptions, type ProjectionOptions, type ProjectionOptionsInput } from "./options.js";
import { createEntitiesProjector } from "./projectors/entities.js";
import { createSessionsProjector } from "./projectors/sessions.js";
import { createZonesProjector } from "./projectors/zones.js";
import { createEncountersProjector } from "./projectors/encounters.js";
import { createActorStatsProjector } from "./projectors/actor-stats.js";
import { createBucketsProjector } from "./projectors/buckets.js";
import { createDomainProjector } from "./projectors/domain.js";
import type { Db, PassContext, PassEvent, Projector } from "./projectors/types.js";

/** Projectors in dependency order (spec §1). Later ones read earlier rows. */
function buildProjectors(): Projector[] {
  return [
    createEntitiesProjector(),
    createSessionsProjector(),
    createZonesProjector(),
    createEncountersProjector(),
    createActorStatsProjector(),
    createBucketsProjector(),
    createDomainProjector(),
  ];
}

interface RuntimeState {
  projector: Projector;
  lastEventId: number;
}

interface OwnerFile {
  id: number;
  character: string | null;
  server: string | null;
}

interface EventRow {
  id: number;
  payload: string;
  session_id: number | null;
  encounter_id: number | null;
}

export interface DriverResult {
  /** Events processed in this pass. */
  processed: number;
  /** Watermark (max event id) after the pass. */
  headEventId: number;
}

/**
 * Full rebuild: wipe every projector's output and replay from event 1. A rebuild
 * is ALWAYS a full wipe + replay-from-start — there is deliberately no `from`
 * option (a partial wipe with a non-zero start would delete events ≤ start and
 * never reprocess them; partial rebuild is not an M1 need).
 */
export function rebuildProjections(db: Db, optsInput: ProjectionOptionsInput = {}): DriverResult {
  const options = resolveOptions(optsInput);
  const projectors = buildProjectors();
  ensureStateRows(db, projectors);
  const runtime = loadRuntime(db, projectors);
  const ownerFile = getOwnerFile(db);
  const ctx = makeContext(db, options, ownerFile);

  runInTx(db, () => {
    // Reset in reverse dependency order to satisfy FKs; watermark back to 0.
    for (const rs of [...runtime].reverse()) {
      rs.projector.reset(ctx);
      rs.lastEventId = 0;
      setState(db, rs.projector.name, 0, rs.projector.version);
    }
  });

  return runPass(db, options, projectors, runtime, ctx, ownerFile);
}

/** Incremental catch-up to head (idempotent at head). */
export function updateProjections(db: Db, optsInput: ProjectionOptionsInput = {}): DriverResult {
  const options = resolveOptions(optsInput);
  const projectors = buildProjectors();
  ensureStateRows(db, projectors);
  const runtime = loadRuntime(db, projectors);
  const ownerFile = getOwnerFile(db);
  const ctx = makeContext(db, options, ownerFile);

  // Version-bump handling (spec §9.3): reset the earliest mismatched projector
  // AND every projector downstream of it — later projectors read the outputs of
  // earlier ones, so a bumped upstream projector must force its dependents to
  // re-derive too (a leaf bump resets only itself + trailing leaves). The
  // registry is dependency-ordered, so "reset i and all j > i" is the simple,
  // clearly-correct cascade. Reset in reverse order to satisfy FKs.
  const firstMismatch = runtime.findIndex(
    (rs) => storedVersion(db, rs.projector.name) !== rs.projector.version,
  );
  if (firstMismatch >= 0) {
    const toReset = runtime.slice(firstMismatch);
    runInTx(db, () => {
      for (const rs of [...toReset].reverse()) {
        rs.projector.reset(ctx);
        rs.lastEventId = 0;
        setState(db, rs.projector.name, 0, rs.projector.version);
      }
    });
  }

  return runPass(db, options, projectors, runtime, ctx, ownerFile);
}

// ── Core pass ──────────────────────────────────────────────────────────────

function runPass(
  db: Db,
  options: ProjectionOptions,
  projectors: Projector[],
  runtime: RuntimeState[],
  ctx: PassContext,
  ownerFile: OwnerFile | null,
): DriverResult {
  const startId = Math.min(...runtime.map((r) => r.lastEventId));

  // Build the resolver: overrides first, then warm up over already-processed
  // events so attribution is current at the start point (spec §1).
  applyOverrides(db, ctx.resolver);
  if (ownerFile !== null) warmUpResolver(db, ctx.resolver, startId);

  // Each projector reconstructs its working state from persisted rows (bounded
  // by its own watermark — rows for not-yet-processed events already exist).
  for (const rs of runtime) rs.projector.load(ctx, rs.lastEventId);

  const rows = db
    .prepare(
      `SELECT id, payload, session_id, encounter_id
       FROM events WHERE id > ? ORDER BY log_file_id, seq, id`,
    )
    .all(startId) as EventRow[];

  let processed = 0;
  let head = startId;
  const stmtState = db.prepare(
    "UPDATE projection_state SET last_event_id = ? WHERE projector = ?",
  );

  for (let i = 0; i < rows.length; i += options.batchSize) {
    const chunk = rows.slice(i, i + options.batchSize);
    runInTx(db, () => {
      for (const row of chunk) {
        // payload is trusted data written by the @eqlcc/event-schema serializer
        // at ingestion (the typed LogEvent), so a plain parse+cast is safe here.
        const event = JSON.parse(row.payload) as LogEvent;
        const pe: PassEvent = {
          event,
          id: row.id,
          sessionId: row.session_id,
          encounterId: row.encounter_id,
        };
        ctx.resolver.observe(event);
        for (const rs of runtime) {
          if (row.id > rs.lastEventId) {
            rs.projector.apply(ctx, pe);
            rs.lastEventId = row.id;
          }
        }
        head = row.id;
        processed += 1;
      }
      // Same-transaction watermark advance for the writes just made.
      for (const rs of runtime) stmtState.run(rs.lastEventId, rs.projector.name);
    });
  }

  // End-of-pass finalize (entities sync final resolver state) in one tx.
  runInTx(db, () => {
    for (const rs of runtime) rs.projector.finalize?.(ctx);
  });

  return { processed, headEventId: head };
}

// ── State helpers ────────────────────────────────────────────────────────────

function ensureStateRows(db: Db, projectors: Projector[]): void {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO projection_state (projector, last_event_id, version) VALUES (?, 0, ?)",
  );
  runInTx(db, () => {
    for (const p of projectors) insert.run(p.name, p.version);
  });
}

function loadRuntime(db: Db, projectors: Projector[]): RuntimeState[] {
  return projectors.map((projector) => ({
    projector,
    lastEventId: storedLastEventId(db, projector.name),
  }));
}

function storedLastEventId(db: Db, name: string): number {
  const row = db
    .prepare("SELECT last_event_id AS v FROM projection_state WHERE projector = ?")
    .get(name) as { v: number } | undefined;
  return row?.v ?? 0;
}

function storedVersion(db: Db, name: string): number {
  const row = db
    .prepare("SELECT version AS v FROM projection_state WHERE projector = ?")
    .get(name) as { v: number } | undefined;
  return row?.v ?? 0;
}

function setState(db: Db, name: string, lastEventId: number, version: number): void {
  db.prepare(
    "UPDATE projection_state SET last_event_id = ?, version = ? WHERE projector = ?",
  ).run(lastEventId, version, name);
}

// ── Context / resolver construction ──────────────────────────────────────────

function getOwnerFile(db: Db): OwnerFile | null {
  const row = db
    .prepare("SELECT id, character_name AS character, server FROM log_files ORDER BY id LIMIT 1")
    .get() as OwnerFile | undefined;
  return row ?? null;
}

function makeContext(db: Db, options: ProjectionOptions, ownerFile: OwnerFile | null): PassContext {
  const resolver = new EntityResolver({
    owner: {
      character: ownerFile?.character ?? null,
      server: ownerFile?.server ?? null,
      logFileId: ownerFile?.id ?? null,
    },
  });
  const ownerId = resolver.resolve("you").canonical;
  const entities = new EntityIndex(db, ownerFile?.server ?? null);
  return {
    db,
    options,
    resolver,
    entities,
    logFileId: ownerFile?.id ?? 0,
    ownerId,
  };
}

/** Replay user corrections onto a fresh resolver (they win over heuristics). */
function applyOverrides(db: Db, resolver: EntityResolver): void {
  const rows = db
    .prepare(
      `SELECT eo.field AS field, eo.new_value AS value, e.canonical_name AS name
       FROM entity_overrides eo JOIN entities e ON e.id = eo.entity_id
       ORDER BY eo.id`,
    )
    .all() as { field: string; value: string; name: string }[];
  for (const row of rows) {
    if (row.field === "kind") {
      resolver.setEntityKind(row.name, row.value as EntityKind, { asserted: true });
    } else if (row.field === "owner") {
      const owner = db
        .prepare("SELECT canonical_name AS name FROM entities WHERE id = ?")
        .get(Number(row.value)) as { name: string } | undefined;
      if (owner !== undefined) resolver.setPetOwner(row.name, owner.name, { asserted: true });
    }
    // 'merge_into' is not supported in M1 (see README open items).
  }
}

/** Observe every event with id ≤ startId so the resolver is current at the start. */
function warmUpResolver(db: Db, resolver: EntityResolver, startId: number): void {
  if (startId <= 0) return;
  const rows = db
    .prepare("SELECT payload FROM events WHERE id <= ? ORDER BY log_file_id, seq, id")
    .all(startId) as { payload: string }[];
  for (const row of rows) resolver.observe(JSON.parse(row.payload) as LogEvent);
}

function runInTx(db: Db, fn: () => void): void {
  db.transaction(fn)();
}
