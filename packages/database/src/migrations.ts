/**
 * Ordered registry of forward-only migrations (DATA_MODEL.md §1, ADR-7).
 *
 * SQL lives in `packages/database/migrations/NNNN_name.sql` (the canonical
 * artifact referenced by DATA_MODEL.md). This registry is the single ordered
 * list; `loadMigrations()` reads each file's SQL. The migrations directory is
 * located relative to this module so it resolves the same whether running from
 * `src/` (vitest) or `dist/src/` (packaged), and it ships via package `files`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface Migration {
  /** Monotonic version; matches the `NNNN` filename prefix. */
  version: number;
  /** Human-readable name; matches the filename body. */
  name: string;
  /** The migration SQL, applied inside a single transaction. */
  sql: string;
}

/** Ordered forward-only migration filenames. Append here; never reorder or edit applied entries. */
const MIGRATION_FILES = ["0001_init.sql"] as const;

function locateMigrationsDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "migrations");
    if (fs.existsSync(path.join(candidate, MIGRATION_FILES[0]))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `@eqlcc/database: could not locate the migrations directory from ${import.meta.url}`,
  );
}

/** Read all migrations, ordered by version. */
export function loadMigrations(): Migration[] {
  const dir = locateMigrationsDir();
  const migrations = MIGRATION_FILES.map((file): Migration => {
    const match = /^(\d+)_(.+)\.sql$/.exec(file);
    if (!match) throw new Error(`@eqlcc/database: malformed migration filename '${file}'`);
    return {
      version: Number(match[1]),
      name: match[2] as string,
      sql: fs.readFileSync(path.join(dir, file), "utf8"),
    };
  });
  return migrations.sort((a, b) => a.version - b.version);
}

/** The highest migration version this build knows about. */
export function latestKnownVersion(migrations: readonly Migration[] = loadMigrations()): number {
  return migrations.reduce((max, m) => Math.max(max, m.version), 0);
}
