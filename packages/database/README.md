# @eqlcc/database

SQLite persistence for EQL Command Center: forward-only numbered migrations, the
append-only `events` schema, and the transactional **(byte_offset, seq)
watermark** ingestion API (issue #9). Depends only on `@eqlcc/event-schema`.

Runtime: **better-sqlite3** in Node / tests / CLI (ARCHITECTURE.md ADR-6). The
Tauri `tauri-plugin-sql` mirror behind the same tiny seam is **M2** — not built
here. `SqlDatabase` is the single seam the package depends on.

## Migrations

- SQL lives in `migrations/NNNN_name.sql` (the canonical artifact DATA_MODEL.md
  §1 references). `migrations.ts` is the ordered registry.
- `migrate(db, options?)` applies all pending migrations in version order, each
  in its own transaction, recording each in `schema_migrations`. It is a no-op
  when up to date and **refuses to run against a DB newer than this build
  knows** (DATA_MODEL.md §1) rather than risk corruption.
- Forward-only: no down migrations (ADR-7). Recovery is restore-from-backup or
  rebuild projections from `events`.
- `options.backupPath` triggers a `VACUUM INTO` snapshot before applying
  (ARCHITECTURE.md §1); param-guarded so tests don't thrash.

```ts
import { openDatabase, migrate, upsertLogFile, ingestEvents, getWatermark } from "@eqlcc/database";

const db = openDatabase("app.db");              // PRAGMA foreign_keys=ON; WAL for file DBs
migrate(db);                                    // apply pending migrations
const id = upsertLogFile(db, { path: "/logs/eqlog_Playerone_erudin.txt", dialectId: "eql-beta-2026-07" });
```

## Ingestion (the core invariant)

`ingestEvents(db, logFileId, events, watermark?)` appends the events to the
append-only `events` table **and** advances the `log_files` `(byte_offset, seq)`
resume watermark **in the same transaction** (ARCHITECTURE.md §5). Crash-safety
reduces to SQLite durability: either the events and the advanced watermark both
land, or neither does.

- **Idempotent, lossless.** Insertion uses a targeted
  `ON CONFLICT(log_file_id, byte_offset) DO NOTHING`: a real byte-offset replay
  is a no-op, but any other constraint violation — notably a duplicate `seq` at a
  different byte offset — **throws and rolls the batch back**, so no line is ever
  silently dropped. The watermark advances forward-only (`MAX(...)`), so a replay
  never regresses it.
- **Watermark only advances when justified by the batch.** An empty batch never
  moves it (a non-empty explicit watermark for an empty batch is rejected); an
  explicit watermark must match the batch extent (its `seq` equals the batch max;
  its `byteOffset` is one terminator past the last line), so a duplicate-only
  re-ingest carrying an inflated watermark cannot skip unread bytes.
- **`watermark`** — production passes the tailer's batch watermark (`byteOffset`,
  next byte to read) and the parser's last `seq`. Omit it and it is derived from
  the batch extent (max seq; one byte past the last complete line).
- **`getWatermark(db, logFileId)`** returns `{ byteOffset, seq }` for tailer
  resume — restored transactionally per the DATA_MODEL Ordering amendment.

Ordering: canonical event order is `(log_file_id, seq)` — equivalently
`(log_file_id, byte_offset)` — never `ts` alone (DATA_MODEL.md Ordering
amendment).

## Schema

`migrations/0001_init.sql` implements the DATA_MODEL.md tables: `log_files`,
`events` (append-only source of truth), `unknown_line_stats`, `entities`,
`entity_links`, `entity_overrides`, `sessions`, `zones`, `zone_visits`,
`encounters`, `encounter_participants`, and the projections `xp_events`,
`aa_events`, `loot_events`, `currency_ledger`, `faction_events`, `skill_events`,
`projection_state`, `encounter_actor_stats`, `encounter_buckets`. Projection
*writers* (populating these from `events`) are a later task; this package
provides the schema, migrations, and event ingestion.
