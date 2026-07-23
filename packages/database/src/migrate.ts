/**
 * Migration runner (DATA_MODEL.md §1, ADR-7).
 *
 * - Forward-only: applies every pending migration in version order, each inside
 *   its own transaction, recording it in `schema_migrations`.
 * - Refuses to run against a DB whose schema is NEWER than this build knows,
 *   rather than corrupt it (DATA_MODEL.md §1).
 * - Optional VACUUM INTO snapshot before applying (ARCHITECTURE.md §1); param-
 *   guarded so tests don't thrash.
 */

import type { SqlDatabase } from "./db.js";
import { latestKnownVersion, loadMigrations, type Migration } from "./migrations.js";

export interface MigrateOptions {
  /**
   * If set, snapshot the DB to this path via `VACUUM INTO` before applying any
   * pending migration (ARCHITECTURE.md §1). Omit in tests / when there is
   * nothing to apply.
   */
  backupPath?: string;
  /** Override the migration set (tests). Defaults to the on-disk registry. */
  migrations?: Migration[];
}

export interface MigrateResult {
  /** Versions applied during this call (empty if already up to date). */
  applied: number[];
  /** Schema version after this call. */
  currentVersion: number;
}

/** DDL for the runner-owned bookkeeping table (DATA_MODEL.md §1). */
const SCHEMA_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);`;

/** Current applied schema version (0 if the DB has never been migrated). */
export function currentSchemaVersion(db: SqlDatabase): number {
  const hasTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!hasTable) return 0;
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {
    v: number | null;
  };
  return row.v ?? 0;
}

/**
 * Apply all pending migrations in order. Idempotent: a second call with no new
 * migrations is a no-op. Throws if the DB is newer than this build supports.
 */
export function migrate(db: SqlDatabase, options: MigrateOptions = {}): MigrateResult {
  const migrations = (options.migrations ?? loadMigrations())
    .slice()
    .sort((a, b) => a.version - b.version);
  const latest = latestKnownVersion(migrations);

  const current = currentSchemaVersion(db);
  if (current > latest) {
    throw new Error(
      `@eqlcc/database: database schema version ${current} is newer than this app ` +
        `supports (${latest}). Refusing to open to avoid corruption — upgrade the app ` +
        `or restore from backup (DATA_MODEL.md §1).`,
    );
  }

  const pending = migrations.filter((m) => m.version > current);
  if (pending.length === 0) return { applied: [], currentVersion: current };

  // Pre-migration snapshot (optional; skipped when unset so tests don't thrash).
  // Parameterized target — never string-interpolated into SQL.
  if (options.backupPath !== undefined) {
    db.prepare("VACUUM INTO ?").run(options.backupPath);
  }

  // Bookkeeping table is infra, created once outside the migration bodies.
  db.exec(SCHEMA_MIGRATIONS_DDL);

  const applied: number[] = [];
  const insertRow = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const m of pending) {
    const runOne = db.transaction(() => {
      db.exec(m.sql);
      insertRow.run(m.version, m.name, Date.now());
    });
    runOne();
    applied.push(m.version);
  }

  return { applied, currentVersion: latest };
}
