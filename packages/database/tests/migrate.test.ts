import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  currentSchemaVersion,
  latestKnownVersion,
  loadMigrations,
  migrate,
  openDatabase,
} from "../src/index.js";

const tmpFiles: string[] = [];
afterEach(() => {
  for (const f of tmpFiles.splice(0)) fs.rmSync(f, { force: true, recursive: true });
});

/** Every table DATA_MODEL.md defines that 0001 must create. */
const EXPECTED_TABLES = [
  "log_files",
  "events",
  "unknown_line_stats",
  "entities",
  "entity_links",
  "entity_overrides",
  "sessions",
  "zones",
  "zone_visits",
  "encounters",
  "encounter_participants",
  "xp_events",
  "aa_events",
  "loot_events",
  "currency_ledger",
  "faction_events",
  "skill_events",
  "projection_state",
  "encounter_actor_stats",
  "encounter_buckets",
];

function tableNames(db: ReturnType<typeof openDatabase>): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

describe("migrate", () => {
  it("applies cleanly on a fresh in-memory DB and creates every DATA_MODEL table", () => {
    const db = openDatabase(":memory:");
    expect(currentSchemaVersion(db)).toBe(0);

    const result = migrate(db);

    expect(result.applied).toEqual([1]);
    expect(result.currentVersion).toBe(latestKnownVersion());
    expect(currentSchemaVersion(db)).toBe(1);

    const tables = tableNames(db);
    expect(tables.has("schema_migrations")).toBe(true);
    for (const t of EXPECTED_TABLES) expect(tables.has(t), `missing table ${t}`).toBe(true);
  });

  it("is a no-op on the second run (idempotent migration)", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const before = db
      .prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version")
      .all();

    const second = migrate(db);

    expect(second.applied).toEqual([]);
    expect(second.currentVersion).toBe(1);
    const after = db
      .prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version")
      .all();
    expect(after).toEqual(before); // no new rows, no re-stamping
  });

  it("refuses to run against a DB newer than the app knows", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    // Simulate a DB written by a newer app version.
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
      999,
      "from_the_future",
      Date.now(),
    );

    expect(() => migrate(db)).toThrow(/newer than this app/i);
  });

  it("enforces the (log_file_id, byte_offset) and (log_file_id, seq) uniqueness guards", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const indexes = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'")
      .all() as { sql: string | null }[];
    const ddl = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'events'")
      .get() as { sql: string };
    const allSql = ddl.sql + indexes.map((i) => i.sql ?? "").join("\n");
    expect(allSql).toMatch(/log_file_id,\s*byte_offset/);
    expect(allSql).toMatch(/log_file_id,\s*seq/);
  });

  it("writes a VACUUM INTO snapshot before applying when backupPath is given", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eqlcc-db-"));
    const dbPath = path.join(dir, "app.db");
    const backupPath = path.join(dir, "pre-migrate.db");
    tmpFiles.push(dbPath, backupPath, dir);

    // Seed a v1 file DB so there is content to snapshot, then simulate a pending
    // migration by pretending v1 is not yet applied via an override registry.
    const db = openDatabase(dbPath);
    migrate(db); // now at v1

    // A second "migration set" with a higher version forces a pending apply and
    // therefore a snapshot. The SQL is a harmless no-op table.
    const migrations = [
      ...loadMigrations(),
      { version: 2, name: "smoke", sql: "CREATE TABLE _smoke (x INTEGER);" },
    ];
    const result = migrate(db, { migrations, backupPath });

    expect(result.applied).toEqual([2]);
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(fs.statSync(backupPath).size).toBeGreaterThan(0);
    db.close();
  });
});
