# EQL Command Center — Data Model

**Status:** Draft v0.1 (2026-07-22) · SQLite (WAL mode) · See ARCHITECTURE.md for pipeline context.

Core rules:

- `events` is **append-only** and is the source of truth. Everything in §4–§6 is a projection that can
  be rebuilt from `events`.
- Every event preserves its **raw line** and **source byte offset**.
- Derived attributions (pet ownership, XP attribution, encounter membership) always carry
  `evidence_type` + `confidence` — never a silent guess — and user assertions outrank heuristics.
- Timestamps: `INTEGER` Unix epoch **milliseconds**, derived from the log's local-time asctime stamp
  (second precision; parser assigns a monotonic sub-second tiebreak within a second — see open question
  in LOG_FORMAT_SPEC.md §2).

---

## 1. Migrations strategy

- Numbered, **forward-only** SQL migrations: `packages/database/migrations/0001_init.sql`,
  `0002_….sql`, …. No down migrations (ADR-7): a local-first app cannot orchestrate rollbacks; the
  recovery path is restore-from-backup or rebuild projections from `events`.
- Applied inside a transaction; recorded in `schema_migrations`. Startup applies any missing migrations
  in order; a DB **newer** than the app refuses to open (with a clear message) rather than corrupt.
- Migrations that reshape projections may simply drop + recreate them and mark them for rebuild via
  `projection_state`.
- The app snapshots the DB file before applying migrations (cheap: `VACUUM INTO`).

```sql
CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,          -- 1, 2, 3, ...
  name        TEXT NOT NULL,
  applied_at  INTEGER NOT NULL              -- unix ms
);
```

---

## 2. Ingestion tables

```sql
-- One row per physical log file we track.
CREATE TABLE log_files (
  id              INTEGER PRIMARY KEY,
  path            TEXT NOT NULL UNIQUE,     -- absolute path
  character_name  TEXT,                     -- from eqlog_<Character>_<server>.txt
  server          TEXT,                     -- erudin, freeport, neriak, qeynos, halas, oggok, rivervale, paineel, ...
  dialect_id      TEXT NOT NULL,            -- active parser dialect, e.g. 'eql-beta-2026-07'
  byte_offset     INTEGER NOT NULL DEFAULT 0,  -- resume watermark; committed atomically with events
  last_length     INTEGER NOT NULL DEFAULT 0,  -- last observed file length (truncation check: len < offset -> reset 0)
  enabled         INTEGER NOT NULL DEFAULT 1,
  first_seen_at   INTEGER NOT NULL,
  last_read_at    INTEGER
);

-- Append-only typed event log. Source of truth.
CREATE TABLE events (
  id                INTEGER PRIMARY KEY,     -- rowid; insertion order == log order per file
  log_file_id       INTEGER NOT NULL REFERENCES log_files(id),
  byte_offset       INTEGER NOT NULL,        -- offset of the line's first byte in the file
  raw               TEXT NOT NULL,           -- original line, verbatim (minus line terminator)
  ts                INTEGER NOT NULL,        -- unix ms
  type              TEXT NOT NULL,           -- event enum, e.g. 'melee_hit' (LOG_FORMAT_SPEC.md §4)
  source_entity_id  INTEGER REFERENCES entities(id),  -- indexed common columns, denormalized
  target_entity_id  INTEGER REFERENCES entities(id),  --   from payload for query speed
  value             INTEGER,                 -- primary magnitude (damage, heal, xp basis pts, faction delta, copper)
  payload           TEXT NOT NULL,           -- JSON: full typed payload incl. spell, school, flags, uncapped amounts
  session_id        INTEGER REFERENCES sessions(id),
  encounter_id      INTEGER REFERENCES encounters(id),   -- nullable; assigned by encounter engine
  dialect_id        TEXT NOT NULL,
  rule_id           TEXT,                    -- recognizer that matched; NULL for raw_unknown
  UNIQUE (log_file_id, byte_offset)          -- idempotent re-ingestion guard
);
CREATE INDEX idx_events_ts        ON events(ts);
CREATE INDEX idx_events_type_ts   ON events(type, ts);
CREATE INDEX idx_events_source    ON events(source_entity_id, ts);
CREATE INDEX idx_events_target    ON events(target_entity_id, ts);
CREATE INDEX idx_events_encounter ON events(encounter_id);

-- Diagnostics rollup of unmatched lines (the lines themselves are events of type 'raw_unknown').
-- shape = raw with digits -> '#', quoted strings -> "'…'"; powers the "top unknown shapes" panel
-- and the unmatched-rate health metric.
CREATE TABLE unknown_line_stats (
  dialect_id   TEXT NOT NULL,
  shape        TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  sample_raw   TEXT NOT NULL,               -- one representative raw line
  first_ts     INTEGER NOT NULL,
  last_ts      INTEGER NOT NULL,
  PRIMARY KEY (dialect_id, shape)
);
```

Retention: `raw_unknown` events are kept indefinitely by default (they are the fixture pipeline);
a user-configurable pruning job may delete `raw_unknown` events older than N days **only after** their
shape is captured in `unknown_line_stats`.

---

## 3. Entities and the evidence/confidence pattern

```sql
CREATE TABLE entities (
  id                     INTEGER PRIMARY KEY,
  canonical_name         TEXT NOT NULL,
  server                 TEXT,                       -- entity namespace; NULL = unknown
  kind                   TEXT NOT NULL DEFAULT 'unknown'
                         CHECK (kind IN ('player','pet','npc','merc','unknown')),
  classification_source  TEXT NOT NULL DEFAULT 'heuristic'
                         CHECK (classification_source IN ('heuristic','user','system')),
  confidence             REAL NOT NULL DEFAULT 0.0,  -- of current kind classification
  first_seen_ts          INTEGER,
  last_seen_ts           INTEGER,
  UNIQUE (canonical_name, server)
);

-- Pet -> owner links. Multiple rows per pet allowed (evidence accumulates); the resolver
-- surfaces the best active link. NEVER a silent guess: every row says why we believe it.
CREATE TABLE entity_links (
  id              INTEGER PRIMARY KEY,
  pet_entity_id   INTEGER NOT NULL REFERENCES entities(id),
  owner_entity_id INTEGER NOT NULL REFERENCES entities(id),
  evidence_type   TEXT NOT NULL CHECK (evidence_type IN (
                    'pet_chatter',            -- "Petone told you, 'Attacking ... Master.'" (VERIFIED, strongest heuristic)
                    'damage_shield_possessive', -- "... burned by Pettwo's flames ..." links name->DS owner context
                    'name_pattern',           -- classic pet-name generator ^[GJKLVXZ]([aeio][bknrs]){0,2}(ab|er|n|tik)$
                    'user_assertion'          -- explicit user correction; confidence 1.0; outranks all
                  )),
  confidence      REAL NOT NULL CHECK (confidence > 0.0 AND confidence <= 1.0),
  first_ts        INTEGER NOT NULL,
  last_ts         INTEGER NOT NULL,
  observation_count INTEGER NOT NULL DEFAULT 1,
  active          INTEGER NOT NULL DEFAULT 1,
  source_event_id INTEGER REFERENCES events(id),     -- first evidence event
  UNIQUE (pet_entity_id, owner_entity_id, evidence_type)
);

-- Audit trail of user corrections (kauffman12-style "Verified Players / Verified Pets").
-- Applying a correction updates entities/entity_links AND appends here; corrections survive
-- projection rebuilds by being replayed last.
CREATE TABLE entity_overrides (
  id            INTEGER PRIMARY KEY,
  entity_id     INTEGER NOT NULL REFERENCES entities(id),
  field         TEXT NOT NULL CHECK (field IN ('kind','owner','merge_into')),
  new_value     TEXT NOT NULL,               -- kind name, owner entity id, or target entity id
  created_at    INTEGER NOT NULL,
  note          TEXT
);
```

Default heuristic confidences (tunable, documented here so behavior is predictable):
`pet_chatter` 0.95 · `damage_shield_possessive` 0.7 · `name_pattern` 0.4 · `user_assertion` 1.0.

---

## 4. Sessions, zones, encounters

```sql
CREATE TABLE sessions (            -- one contiguous play session per log file
  id            INTEGER PRIMARY KEY,
  log_file_id   INTEGER NOT NULL REFERENCES log_files(id),
  started_ts    INTEGER NOT NULL,
  ended_ts      INTEGER,                   -- NULL while live; closed on gap > threshold or log toggle
  character_entity_id INTEGER REFERENCES entities(id)
);

CREATE TABLE zones (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,      -- exact string from ZoneEnter, e.g. 'The Northern Desert of Ro'
  is_instance   INTEGER NOT NULL DEFAULT 0 -- heuristic: 'Expedition' suffix (see spec open questions)
);

CREATE TABLE zone_visits (
  id            INTEGER PRIMARY KEY,
  session_id    INTEGER NOT NULL REFERENCES sessions(id),
  zone_id       INTEGER NOT NULL REFERENCES zones(id),
  entered_ts    INTEGER NOT NULL,
  left_ts       INTEGER
);

CREATE TABLE encounters (
  id                 INTEGER PRIMARY KEY,
  session_id         INTEGER NOT NULL REFERENCES sessions(id),
  zone_id            INTEGER REFERENCES zones(id),
  name               TEXT,                 -- display name: primary target or 'Trash: <zone>'
  primary_target_entity_id INTEGER REFERENCES entities(id),
  started_ts         INTEGER NOT NULL,     -- first combat event
  ended_ts           INTEGER,              -- BACK-DATED to last combat event (not timeout expiry)
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  scale              TEXT NOT NULL DEFAULT 'group' CHECK (scale IN ('group','raid')), -- 15s vs 2min timeout
  difficulty_tier    TEXT CHECK (difficulty_tier IN ('D0','D1','D2','D3','D4')),  -- UNVERIFIED source; user/heuristic
  projector_version  INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_encounters_session ON encounters(session_id);

-- Group-wide membership (ADR-4), with evidence like all attributions.
CREATE TABLE encounter_participants (
  encounter_id   INTEGER NOT NULL REFERENCES encounters(id),
  entity_id      INTEGER NOT NULL REFERENCES entities(id),
  role           TEXT NOT NULL CHECK (role IN ('ally','enemy','unknown')),
  evidence_type  TEXT NOT NULL CHECK (evidence_type IN
                   ('dealt_damage','took_damage','healed_ally','was_healed','pet_of_ally','user_assertion')),
  confidence     REAL NOT NULL,
  PRIMARY KEY (encounter_id, entity_id)
);
```

---

## 5. Domain event projections

Thin, queryable projections of specific event types (each row references its source event).

```sql
CREATE TABLE xp_events (
  id            INTEGER PRIMARY KEY,
  event_id      INTEGER NOT NULL UNIQUE REFERENCES events(id),
  ts            INTEGER NOT NULL,
  session_id    INTEGER NOT NULL REFERENCES sessions(id),
  percent_milli INTEGER NOT NULL,           -- '1.019%' -> 1019 (exact 3-decimal %, stored lossless)
  level_at_time INTEGER,
  kind          TEXT NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal','aa','level_up')),
  attributed_encounter_id INTEGER REFERENCES encounters(id),   -- nearest preceding kill, if any
  evidence_type TEXT CHECK (evidence_type IN ('kill_proximity','user_assertion')),
  confidence    REAL
);

CREATE TABLE aa_events (              -- ability purchases: 'You have gained the ability "X" at a cost of N ability points.'
  id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL UNIQUE REFERENCES events(id),
  ts INTEGER NOT NULL, session_id INTEGER REFERENCES sessions(id),
  ability_name TEXT NOT NULL, cost_points INTEGER NOT NULL
);

CREATE TABLE loot_events (
  id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL UNIQUE REFERENCES events(id),
  ts INTEGER NOT NULL, session_id INTEGER REFERENCES sessions(id),
  item_name  TEXT NOT NULL,
  quantity   INTEGER NOT NULL DEFAULT 1,
  corpse_name TEXT,                          -- e.g. 'a fragile pet'
  mode       TEXT NOT NULL CHECK (mode IN ('kept','auto_sold')),
  sale_total_copper INTEGER                  -- NULL unless auto_sold; 1p=1000c, 1g=100c, 1s=10c
);

CREATE TABLE currency_ledger (               -- every coin delta we can observe (auto-sell verified; others as discovered)
  id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL UNIQUE REFERENCES events(id),
  ts INTEGER NOT NULL, session_id INTEGER REFERENCES sessions(id),
  delta_copper INTEGER NOT NULL,             -- signed
  reason TEXT NOT NULL CHECK (reason IN ('auto_sell','loot_coin','vendor','other'))  -- only 'auto_sell' VERIFIED
);

CREATE TABLE faction_events (
  id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL UNIQUE REFERENCES events(id),
  ts INTEGER NOT NULL, session_id INTEGER REFERENCES sessions(id),
  faction_name TEXT NOT NULL, delta INTEGER NOT NULL   -- verified positive; negative assumed symmetric
);

CREATE TABLE skill_events (                  -- UNVERIFIED format (no fixture yet); schema reserved
  id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL UNIQUE REFERENCES events(id),
  ts INTEGER NOT NULL, session_id INTEGER REFERENCES sessions(id),
  skill_name TEXT NOT NULL, new_value INTEGER
);
```

---

## 6. Analytics rollups (DPS/HPS)

Rebuildable from `events`; `projection_state` tracks incremental progress and versions.

```sql
CREATE TABLE projection_state (
  projector      TEXT PRIMARY KEY,           -- 'encounter_stats', 'encounter_buckets', ...
  last_event_id  INTEGER NOT NULL DEFAULT 0,
  version        INTEGER NOT NULL            -- bump to force full rebuild
);

-- Per-encounter, per-actor totals. One row per (encounter, entity).
CREATE TABLE encounter_actor_stats (
  encounter_id    INTEGER NOT NULL REFERENCES encounters(id),
  entity_id       INTEGER NOT NULL REFERENCES entities(id),
  attrib_owner_id INTEGER REFERENCES entities(id),  -- pets roll up to owner here; NULL if self
  damage_total    INTEGER NOT NULL DEFAULT 0,
  melee_damage    INTEGER NOT NULL DEFAULT 0,
  spell_damage    INTEGER NOT NULL DEFAULT 0,
  dot_damage      INTEGER NOT NULL DEFAULT 0,
  ds_damage       INTEGER NOT NULL DEFAULT 0,
  hit_count       INTEGER NOT NULL DEFAULT 0,
  miss_count      INTEGER NOT NULL DEFAULT 0,
  max_hit         INTEGER NOT NULL DEFAULT 0,
  heal_total      INTEGER NOT NULL DEFAULT 0,       -- capped amounts
  overheal_total  INTEGER NOT NULL DEFAULT 0,       -- sum(uncapped - capped) where uncapped present
  duration_ms     INTEGER NOT NULL DEFAULT 0,       -- encounter span; dps = damage_total / (duration_ms/1000)
  active_stance   TEXT,                             -- stance at encounter start (analytics dimension)
  active_invocation TEXT,
  PRIMARY KEY (encounter_id, entity_id)
);

-- Per-second buckets for live meters and charts (pruned for old encounters, rebuildable).
CREATE TABLE encounter_buckets (
  encounter_id  INTEGER NOT NULL REFERENCES encounters(id),
  entity_id     INTEGER NOT NULL REFERENCES entities(id),
  bucket_ts     INTEGER NOT NULL,            -- unix seconds
  damage        INTEGER NOT NULL DEFAULT 0,
  healing       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (encounter_id, entity_id, bucket_ts)
);
```

Analytics dimensions available for segmentation (per ADR-10): zone, encounter scale, difficulty tier
(nullable, UNVERIFIED source), stance × invocation (from verified stance/invocation events), character
level (from verified level-up events), class trio (UNVERIFIED source — user-entered until observed in
logs).

---

## 7. Conventions

- All FK columns indexed where used in joins; `PRAGMA foreign_keys = ON`.
- `payload` JSON is written by `event-schema` serializers only; columns duplicated out of payload
  (`ts`, `type`, entities, `value`) are for indexing and must equal the payload values.
- Money is always integer copper. Percentages are integer milli-percent. No floats in domain data;
  `confidence` (0–1) is the deliberate exception.
- Deletions: only `raw_unknown` pruning (§2) and `encounter_buckets` pruning (§6). Nothing else is
  deleted; user "deletions" are `entity_overrides` / disabled flags.

## Ordering amendment (2026-07-23, cross-model review PR #15)

Events carry `seq` (per-file monotonic emission ordinal) among the base fields; projections order by `(log_file_id, seq)` — equivalently `(log_file_id, byte_offset)` — never by `ts` alone. On resume, the tailer/parser restores `seq` from the same transactional watermark row as `byte_offset` (`startSeq` parser option).
