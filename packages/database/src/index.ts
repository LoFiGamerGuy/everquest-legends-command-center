/**
 * @eqlcc/database — SQLite persistence for EQL Command Center.
 *
 * Forward-only numbered migrations, the append-only `events` schema, and the
 * transactional (byte_offset, seq) watermark ingestion API (issue #9).
 * Node/tests/CLI via better-sqlite3; the Tauri `tauri-plugin-sql` mirror is M2.
 */

export { openDatabase } from "./db.js";
export type { SqlDatabase, OpenOptions } from "./db.js";

export { loadMigrations, latestKnownVersion } from "./migrations.js";
export type { Migration } from "./migrations.js";

export { migrate, currentSchemaVersion } from "./migrate.js";
export type { MigrateOptions, MigrateResult } from "./migrate.js";

export { ingestEvents, getWatermark, upsertLogFile } from "./ingest.js";
export type { Watermark, IngestResult, LogFileInput } from "./ingest.js";
