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
 */

import type { SqlDatabase } from "@eqlcc/database";
import { loadMigrations, type Migration } from "@eqlcc/database";
import type { ResolverSnapshot } from "@eqlcc/log-parser";

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The resolver-snapshot migration file, orchestrator-owned and applied via
 * migrate({ migrations }) (see resolver-store module doc / 0002 SQL header for
 * why it is composed here rather than registered in @eqlcc/database).
 */
const MIGRATION_FILE = "0002_resolver_snapshot.sql";

/** Locate this package's migrations/ dir from either src/ (vitest) or dist/src/ (packaged). */
function locateMigrationsDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "migrations");
    if (fs.existsSync(path.join(candidate, MIGRATION_FILE))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `@eqlcc/orchestrator: could not locate the migrations directory from ${import.meta.url}`,
  );
}

/**
 * The resolver-snapshot migration, numbered one past the highest base migration
 * so it applies as the next forward-only step through @eqlcc/database's migrate()
 * runner. The SQL uses `CREATE TABLE IF NOT EXISTS`, so re-applying it (or a
 * future relocation into the central registry) is a harmless no-op.
 */
export function resolverSnapshotMigration(): Migration {
  const base = loadMigrations();
  const version = base.reduce((max, m) => Math.max(max, m.version), 0) + 1;
  const sql = fs.readFileSync(path.join(locateMigrationsDir(), MIGRATION_FILE), "utf8");
  return { version, name: "resolver_snapshot", sql };
}

/** The full migration set the pipeline applies: base schema + resolver_snapshot. */
export function pipelineMigrations(): Migration[] {
  return [...loadMigrations(), resolverSnapshotMigration()];
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

/** Read the persisted resolver snapshot, or undefined if none has been stored yet. */
export function loadResolverSnapshot(
  db: SqlDatabase,
  logFileId: number,
): ResolverSnapshot | undefined {
  const row = db
    .prepare("SELECT snapshot FROM resolver_snapshot WHERE log_file_id = ?")
    .get(logFileId) as { snapshot: string } | undefined;
  if (row === undefined) return undefined;
  return JSON.parse(row.snapshot) as ResolverSnapshot;
}
