import { currentSchemaVersion } from "@eqlcc/database";
import { describe, expect, it } from "vitest";

import {
  IngestPipeline,
  loadResolverSnapshot,
  pipelineMigrations,
  resolverSnapshotMigration,
  saveResolverSnapshot,
} from "../src/index.js";

import { freshDb, fullText, logFileInput, writeTempLog } from "./helpers.js";

describe("resolver-snapshot store + migration composition", () => {
  it("numbers the resolver_snapshot migration one past the base schema", () => {
    const migration = resolverSnapshotMigration();
    expect(migration.name).toBe("resolver_snapshot");
    // Base schema is 0001_init, so resolver_snapshot composes as version 2.
    expect(migration.version).toBe(2);
    expect(pipelineMigrations().map((m) => m.version)).toEqual([1, 2]);
  });

  it("init() applies resolver_snapshot as a forward-only migration recorded in schema_migrations", () => {
    const { logPath, cleanup } = writeTempLog(fullText());
    try {
      const db = freshDb(); // base schema only (v1)
      expect(currentSchemaVersion(db)).toBe(1);

      const pipeline = new IngestPipeline({ db, logFile: logFileInput(logPath) });
      pipeline.init();

      expect(currentSchemaVersion(db)).toBe(2);
      const row = db
        .prepare("SELECT name FROM schema_migrations WHERE version = 2")
        .get() as { name: string } | undefined;
      expect(row?.name).toBe("resolver_snapshot");

      const table = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'resolver_snapshot'")
        .get();
      expect(table).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it("round-trips a resolver snapshot (single row per log file, upsert on re-save)", () => {
    const { logPath, cleanup } = writeTempLog(fullText());
    try {
      const db = freshDb();
      const pipeline = new IngestPipeline({ db, logFile: logFileInput(logPath) });
      pipeline.init();
      const logFileId = pipeline.logFileId;

      expect(loadResolverSnapshot(db, logFileId)).toBeUndefined();

      const snap = pipeline.resolver.toSnapshot();
      saveResolverSnapshot(db, logFileId, snap);
      expect(loadResolverSnapshot(db, logFileId)).toEqual(snap);

      // Re-saving replaces the single row rather than inserting a second.
      saveResolverSnapshot(db, logFileId, snap);
      const count = db
        .prepare("SELECT COUNT(*) AS n FROM resolver_snapshot WHERE log_file_id = ?")
        .get(logFileId) as { n: number };
      expect(count.n).toBe(1);
    } finally {
      cleanup();
    }
  });
});
