import { currentSchemaVersion, latestKnownVersion, migrate } from "@eqlcc/database";
import { describe, expect, it } from "vitest";

import {
  IngestPipeline,
  ensureResolverSnapshotTable,
  loadResolverSnapshot,
  saveResolverSnapshot,
} from "../src/index.js";

import { freshDb, fullText, logFileInput, writeTempLog } from "./helpers.js";

describe("resolver-snapshot store (interim: outside the migration chain)", () => {
  it("init() creates resolver_snapshot WITHOUT bumping schema_version, so central migrate(db) still opens the DB", () => {
    const { logPath, cleanup } = writeTempLog(fullText());
    try {
      const db = freshDb(); // base schema only
      const baseVersion = currentSchemaVersion(db);
      expect(baseVersion).toBe(latestKnownVersion()); // == central registry's latest (1)

      const pipeline = new IngestPipeline({ db, logFile: logFileInput(logPath) });
      pipeline.init();

      // The cache table exists...
      const table = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'resolver_snapshot'")
        .get();
      expect(table).toBeDefined();

      // ...but schema_version is UNCHANGED (it is not a numbered migration), and
      // it left no row in schema_migrations, so @eqlcc/database's migrate(db) —
      // which knows only the base version — does NOT refuse the DB as "newer".
      expect(currentSchemaVersion(db)).toBe(baseVersion);
      const bogus = db
        .prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version > ?")
        .get(baseVersion) as { n: number };
      expect(bogus.n).toBe(0);
      expect(() => migrate(db)).not.toThrow();
      expect(migrate(db).applied).toEqual([]); // nothing pending; DB opens cleanly
    } finally {
      cleanup();
    }
  });

  it("ensureResolverSnapshotTable is idempotent", () => {
    const db = freshDb();
    expect(() => {
      ensureResolverSnapshotTable(db);
      ensureResolverSnapshotTable(db);
    }).not.toThrow();
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

  it("version gate: a snapshot row written by a DIFFERENT schema version is discarded, not restored", () => {
    const { logPath, cleanup } = writeTempLog(fullText());
    try {
      const db = freshDb();
      const pipeline = new IngestPipeline({ db, logFile: logFileInput(logPath) });
      pipeline.init();
      const logFileId = pipeline.logFileId;

      // Persist a valid snapshot, then tamper its stored version to a future one.
      saveResolverSnapshot(db, logFileId, pipeline.resolver.toSnapshot());
      db.prepare("UPDATE resolver_snapshot SET version = 999 WHERE log_file_id = ?").run(logFileId);

      // The stale-schema blob is discarded (rebuildable cache), never fed to
      // EntityResolver.fromSnapshot.
      expect(loadResolverSnapshot(db, logFileId)).toBeUndefined();

      // A fresh pipeline therefore starts from a FRESH resolver (owner known from
      // the file name; no restored entities), not from the mismatched blob.
      const resumed = new IngestPipeline({ db, logFile: logFileInput(logPath) });
      expect(resumed.resolver.list()).toHaveLength(1); // only the owner entity
      expect(resumed.resolver.owner.character).toBe("Playerone");
    } finally {
      cleanup();
    }
  });
});
