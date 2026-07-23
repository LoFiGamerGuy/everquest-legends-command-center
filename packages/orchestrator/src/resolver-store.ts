/**
 * Resolver-snapshot persistence (ARCHITECTURE.md ADR-5, DATA_MODEL.md §3).
 *
 * The {@link EntityResolver} maintains attribution state (pet->owner links, kind
 * classifications, user assertions, and their evidence). To survive a mid-file
 * crash/restart WITHOUT re-reading the whole file, that state is snapshotted to a
 * dedicated single-row-per-log-file store and restored on resume.
 *
 * Atomicity contract (the reason this lives beside the pipeline): the snapshot
 * write MUST be committed in the SAME transaction as the event batch + watermark
 * advance (see IngestPipeline.commit). Otherwise a crash between the two could
 * leave the watermark ahead of the snapshot — the resolver would then miss the
 * attribution signals in the already-ingested-but-un-snapshotted lines, because
 * resume never re-reads them. Keeping snapshot, events, and watermark in one
 * transaction makes the snapshot always exactly as fresh as the watermark.
 *
 * Schema home (INTERIM, issue #19): the resolver_snapshot table is created
 * idempotently via {@link ensureResolverSnapshotTable} (CREATE TABLE IF NOT
 * EXISTS) at pipeline init, and is deliberately kept OUT of the versioned
 * migration chain / schema_migrations. Putting it in the chain would bump the
 * DB's schema_version past @eqlcc/database's central registry value, and its
 * migrate(db) — which knows only the base version — would then REFUSE TO OPEN the
 * DB as "newer than supported" (and would collide with a future central 0002).
 * #20 will formalize this as a real numbered migration in the central registry;
 * the IF NOT EXISTS DDL makes that relocation a no-op. See sql/resolver_snapshot.sql.
 */

import type { SqlDatabase } from "@eqlcc/database";
import { EntityResolver, type ResolverSnapshot } from "@eqlcc/log-parser";

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** DDL file (orchestrator-owned; applied idempotently, NOT a numbered migration — see module doc). */
const DDL_FILE = "resolver_snapshot.sql";

/**
 * The snapshot schema version this build writes and accepts. Read once from a
 * fresh resolver so it tracks the resolver's own ResolverSnapshot.version rather
 * than duplicating the literal.
 */
const CURRENT_SNAPSHOT_VERSION: number = new EntityResolver().toSnapshot().version;

/** Locate this package's sql/ dir from either src/ (vitest) or dist/src/ (packaged). */
function locateSqlDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "sql");
    if (fs.existsSync(path.join(candidate, DDL_FILE))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`@eqlcc/orchestrator: could not locate the sql directory from ${import.meta.url}`);
}

/**
 * Ensure the resolver_snapshot table exists (idempotent; outside the migration
 * chain — see module doc). Safe to call on every init and on an already-migrated
 * DB; it never changes schema_version, so @eqlcc/database's migrate(db) still
 * opens the DB.
 */
export function ensureResolverSnapshotTable(db: SqlDatabase): void {
  const sql = fs.readFileSync(path.join(locateSqlDir(), DDL_FILE), "utf8");
  db.exec(sql);
}

const UPSERT_SNAPSHOT_SQL = `INSERT INTO resolver_snapshot (log_file_id, version, snapshot, updated_at)
  VALUES (@logFileId, @version, @snapshot, @now)
  ON CONFLICT(log_file_id) DO UPDATE SET
    version    = excluded.version,
    snapshot   = excluded.snapshot,
    updated_at = excluded.updated_at`;

/**
 * Persist the resolver snapshot for a tracked file (single row per log file).
 * MUST be called inside the same transaction as the event batch it corresponds
 * to (see module doc).
 */
export function saveResolverSnapshot(
  db: SqlDatabase,
  logFileId: number,
  snapshot: ResolverSnapshot,
): void {
  db.prepare(UPSERT_SNAPSHOT_SQL).run({
    logFileId,
    version: snapshot.version,
    snapshot: JSON.stringify(snapshot),
    now: Date.now(),
  });
}

/**
 * Read the persisted resolver snapshot, or undefined if none is stored.
 *
 * Version gate: the snapshot is a REBUILDABLE cache, not a source of truth, so a
 * row written by a DIFFERENT snapshot schema is DISCARDED (returns undefined →
 * the caller starts a fresh resolver and rebuilds from events) rather than fed to
 * EntityResolver.fromSnapshot, which must never trust a stale-schema blob.
 */
export function loadResolverSnapshot(
  db: SqlDatabase,
  logFileId: number,
): ResolverSnapshot | undefined {
  const row = db
    .prepare("SELECT version, snapshot FROM resolver_snapshot WHERE log_file_id = ?")
    .get(logFileId) as { version: number; snapshot: string } | undefined;
  if (row === undefined) return undefined;
  if (row.version !== CURRENT_SNAPSHOT_VERSION) return undefined; // stale schema; discard & rebuild
  return JSON.parse(row.snapshot) as ResolverSnapshot;
}
