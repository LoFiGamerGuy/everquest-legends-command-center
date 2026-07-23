/**
 * Connection helpers over better-sqlite3 (ARCHITECTURE.md ADR-6).
 *
 * M1 uses better-sqlite3 directly in Node/tests/CLI. The `SqlDatabase` alias is
 * the single seam the rest of the package depends on; the Tauri
 * `tauri-plugin-sql` mirror (M2) will implement the same minimal surface
 * (exec / prepare / transaction) behind it. Kept deliberately tiny.
 */

import Database from "better-sqlite3";
import type { Database as BetterSqliteDatabase } from "better-sqlite3";

/** The database handle the package operates on. */
export type SqlDatabase = BetterSqliteDatabase;

export interface OpenOptions {
  /** Open read-only (resume/inspection). Default false. */
  readonly?: boolean;
  /**
   * Apply WAL journal mode (DATA_MODEL.md: "SQLite (WAL mode)"). WAL is a no-op
   * for `:memory:`, so it defaults on only for file-backed databases.
   */
  wal?: boolean;
}

/**
 * Open (or create) a database with the invariants every EQL DB needs:
 * `PRAGMA foreign_keys = ON` (DATA_MODEL.md §7) and, for file DBs, WAL mode.
 * Defaults to an in-memory DB for tests.
 */
export function openDatabase(filename = ":memory:", options: OpenOptions = {}): SqlDatabase {
  const db = options.readonly ? new Database(filename, { readonly: true }) : new Database(filename);
  db.pragma("foreign_keys = ON");
  // WAL is a write operation (it mutates the journal mode), so it is off by
  // default for read-only opens and for :memory: (where it is a no-op anyway);
  // set `wal: true` to force it.
  const useWal = options.wal ?? (!options.readonly && filename !== ":memory:");
  if (useWal) db.pragma("journal_mode = WAL");
  return db;
}
