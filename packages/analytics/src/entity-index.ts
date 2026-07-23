/**
 * name → `entities.id` index (docs/PROJECTIONS_SPEC.md §2).
 *
 * Every projector that needs an entity FK resolves it through this index, which
 * upserts a row into `entities` on first sight and caches the id. Ids are
 * therefore assigned in first-seen order, which is deterministic for a fixed
 * event stream — so a rebuild and an incremental catch-up produce byte-identical
 * ids (§9.1/§9.2). Kind/confidence/first-last-seen are synced from the final
 * resolver state by the entities projector's finalize step; here we only
 * guarantee the row (and its id) exist.
 *
 * The `entities` UNIQUE is `(canonical_name, server)` and SQLite treats NULL
 * servers as distinct, so we do an explicit SELECT-then-INSERT keyed on
 * `server IS ?` rather than relying on ON CONFLICT (which would not fire for a
 * NULL namespace).
 */

import type { Db } from "./projectors/types.js";

interface IdRow {
  id: number;
  canonical_name: string;
}

export class EntityIndex {
  private readonly cache = new Map<string, number>();
  private readonly selectStmt;
  private readonly insertStmt;

  constructor(
    private readonly db: Db,
    /** Entity namespace (the log owner's server); may be null. */
    private readonly server: string | null,
  ) {
    this.selectStmt = db.prepare(
      "SELECT id FROM entities WHERE canonical_name = ? AND server IS ?",
    );
    this.insertStmt = db.prepare(
      `INSERT INTO entities (canonical_name, server, kind, classification_source, confidence)
       VALUES (?, ?, 'unknown', 'heuristic', 0.0)`,
    );
  }

  /** Warm the cache from persisted rows in this namespace (pass start). */
  load(): void {
    this.cache.clear();
    const rows = this.db
      .prepare("SELECT id, canonical_name FROM entities WHERE server IS ?")
      .all(this.server) as IdRow[];
    for (const r of rows) this.cache.set(r.canonical_name, r.id);
  }

  /** The entities.id for a canonical name if a row already exists (no insert). */
  peek(canonical: string): number | undefined {
    const cached = this.cache.get(canonical);
    if (cached !== undefined) return cached;
    const existing = this.selectStmt.get(canonical, this.server) as { id: number } | undefined;
    if (existing !== undefined) {
      this.cache.set(canonical, existing.id);
      return existing.id;
    }
    return undefined;
  }

  /** The entities.id for a canonical name, inserting a placeholder row if new. */
  idFor(canonical: string): number {
    const cached = this.cache.get(canonical);
    if (cached !== undefined) return cached;
    const existing = this.selectStmt.get(canonical, this.server) as { id: number } | undefined;
    if (existing !== undefined) {
      this.cache.set(canonical, existing.id);
      return existing.id;
    }
    const info = this.insertStmt.run(canonical, this.server);
    const id = Number(info.lastInsertRowid);
    this.cache.set(canonical, id);
    return id;
  }
}
