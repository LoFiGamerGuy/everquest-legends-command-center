-- 0001_init — initial schema for EQL Command Center (docs/DATA_MODEL.md).
--
-- Forward-only migration (ADR-7): no down migration. Applied inside a single
-- transaction by migrate(); recorded in schema_migrations.
--
-- Ordering amendment (2026-07-23, DATA_MODEL.md §"Ordering amendment"):
--   * events carry `seq` (per-file monotonic emission ordinal).
--   * log_files carries a `seq` watermark restored transactionally with
--     `byte_offset` on resume.
--   * canonical order is (log_file_id, seq) — equivalently (log_file_id,
--     byte_offset) — never `ts` alone.
--
-- FK note: PRAGMA foreign_keys is enabled at connection open (it is a no-op
-- inside the migration transaction). Tables are created parent-before-child.

-- Note: the schema_migrations bookkeeping table (DATA_MODEL.md §1) is owned by
-- the migrate() runner (created idempotently before any migration runs), not by
-- a migration, so it can never collide with a re-applied migration body.

-- ── §2 Ingestion: tracked files ────────────────────────────────────────────
CREATE TABLE log_files (
  id              INTEGER PRIMARY KEY,
  path            TEXT NOT NULL UNIQUE,        -- absolute path
  character_name  TEXT,                        -- from eqlog_<Character>_<server>.txt
  server          TEXT,                        -- erudin, freeport, neriak, ...
  dialect_id      TEXT NOT NULL,               -- active parser dialect, e.g. 'eql-beta-2026-07'
  byte_offset     INTEGER NOT NULL DEFAULT 0,  -- resume watermark; committed atomically with events
  seq             INTEGER NOT NULL DEFAULT 0,  -- seq watermark (Ordering amendment); restored with byte_offset
  last_length     INTEGER NOT NULL DEFAULT 0,  -- last observed file length (len < offset -> truncation reset)
  enabled         INTEGER NOT NULL DEFAULT 1,
  first_seen_at   INTEGER NOT NULL,
  last_read_at    INTEGER
);

-- ── §3 Entities and the evidence/confidence pattern ────────────────────────
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

-- ── §4 Sessions, zones, encounters ─────────────────────────────────────────
CREATE TABLE sessions (
  id                  INTEGER PRIMARY KEY,
  log_file_id         INTEGER NOT NULL REFERENCES log_files(id),
  started_ts          INTEGER NOT NULL,
  ended_ts            INTEGER,                   -- NULL while live
  character_entity_id INTEGER REFERENCES entities(id)
);
CREATE INDEX idx_sessions_log_file ON sessions(log_file_id);

CREATE TABLE zones (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,      -- exact string from ZoneEnter
  is_instance   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE zone_visits (
  id            INTEGER PRIMARY KEY,
  session_id    INTEGER NOT NULL REFERENCES sessions(id),
  zone_id       INTEGER NOT NULL REFERENCES zones(id),
  entered_ts    INTEGER NOT NULL,
  left_ts       INTEGER
);
CREATE INDEX idx_zone_visits_session ON zone_visits(session_id);
CREATE INDEX idx_zone_visits_zone ON zone_visits(zone_id);

CREATE TABLE encounters (
  id                       INTEGER PRIMARY KEY,
  session_id               INTEGER NOT NULL REFERENCES sessions(id),
  zone_id                  INTEGER REFERENCES zones(id),
  name                     TEXT,               -- primary target or 'Trash: <zone>'
  primary_target_entity_id INTEGER REFERENCES entities(id),
  started_ts               INTEGER NOT NULL,   -- first combat event
  ended_ts                 INTEGER,            -- BACK-DATED to last combat event
  status                   TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  scale                    TEXT NOT NULL DEFAULT 'group' CHECK (scale IN ('group','raid')),
  difficulty_tier          TEXT CHECK (difficulty_tier IN ('D0','D1','D2','D3','D4')),
  projector_version        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_encounters_session ON encounters(session_id);
CREATE INDEX idx_encounters_zone ON encounters(zone_id);

CREATE TABLE encounter_participants (
  encounter_id  INTEGER NOT NULL REFERENCES encounters(id),
  entity_id     INTEGER NOT NULL REFERENCES entities(id),
  role          TEXT NOT NULL CHECK (role IN ('ally','enemy','unknown')),
  evidence_type TEXT NOT NULL CHECK (evidence_type IN
                  ('dealt_damage','took_damage','healed_ally','was_healed','pet_of_ally','user_assertion')),
  confidence    REAL NOT NULL,
  PRIMARY KEY (encounter_id, entity_id)
);
CREATE INDEX idx_encounter_participants_entity ON encounter_participants(entity_id);

-- ── §2 Append-only typed event log. Source of truth. ───────────────────────
CREATE TABLE events (
  id                INTEGER PRIMARY KEY,     -- rowid; insertion order == log order per file
  log_file_id       INTEGER NOT NULL REFERENCES log_files(id),
  seq               INTEGER NOT NULL,        -- per-file monotonic emission ordinal (Ordering amendment)
  byte_offset       INTEGER NOT NULL,        -- offset of the line's first byte in the file
  raw               TEXT NOT NULL,           -- original line, verbatim (minus terminator)
  ts                INTEGER NOT NULL,        -- unix ms
  type              TEXT NOT NULL,           -- event enum, e.g. 'melee_hit'
  source_entity_id  INTEGER REFERENCES entities(id),  -- denormalized from payload; resolved downstream
  target_entity_id  INTEGER REFERENCES entities(id),
  value             INTEGER,                 -- primary magnitude (damage, heal, xp, faction delta, copper)
  payload           TEXT NOT NULL,           -- JSON: full typed payload
  session_id        INTEGER REFERENCES sessions(id),
  encounter_id      INTEGER REFERENCES encounters(id),  -- nullable; assigned by encounter engine
  dialect_id        TEXT NOT NULL,
  rule_id           TEXT,                    -- recognizer that matched; NULL for raw_unknown
  UNIQUE (log_file_id, byte_offset),         -- idempotent re-ingestion guard
  UNIQUE (log_file_id, seq)                  -- canonical-order key; per-file monotonic
);
CREATE INDEX idx_events_ts        ON events(ts);
CREATE INDEX idx_events_type_ts   ON events(type, ts);
CREATE INDEX idx_events_source    ON events(source_entity_id, ts);
CREATE INDEX idx_events_target    ON events(target_entity_id, ts);
CREATE INDEX idx_events_encounter ON events(encounter_id);
CREATE INDEX idx_events_session   ON events(session_id);

CREATE TABLE unknown_line_stats (
  dialect_id   TEXT NOT NULL,
  shape        TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  sample_raw   TEXT NOT NULL,
  first_ts     INTEGER NOT NULL,
  last_ts      INTEGER NOT NULL,
  PRIMARY KEY (dialect_id, shape)
);

-- Pet -> owner links (evidence accumulates). References events(id).
CREATE TABLE entity_links (
  id                INTEGER PRIMARY KEY,
  pet_entity_id     INTEGER NOT NULL REFERENCES entities(id),
  owner_entity_id   INTEGER NOT NULL REFERENCES entities(id),
  evidence_type     TEXT NOT NULL CHECK (evidence_type IN (
                      'pet_chatter','damage_shield_possessive','name_pattern','user_assertion')),
  confidence        REAL NOT NULL CHECK (confidence > 0.0 AND confidence <= 1.0),
  first_ts          INTEGER NOT NULL,
  last_ts           INTEGER NOT NULL,
  observation_count INTEGER NOT NULL DEFAULT 1,
  active            INTEGER NOT NULL DEFAULT 1,
  source_event_id   INTEGER REFERENCES events(id),
  UNIQUE (pet_entity_id, owner_entity_id, evidence_type)
);
CREATE INDEX idx_entity_links_pet ON entity_links(pet_entity_id);
CREATE INDEX idx_entity_links_owner ON entity_links(owner_entity_id);

CREATE TABLE entity_overrides (
  id            INTEGER PRIMARY KEY,
  entity_id     INTEGER NOT NULL REFERENCES entities(id),
  field         TEXT NOT NULL CHECK (field IN ('kind','owner','merge_into')),
  new_value     TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  note          TEXT
);
CREATE INDEX idx_entity_overrides_entity ON entity_overrides(entity_id);

-- ── §5 Domain event projections ────────────────────────────────────────────
CREATE TABLE xp_events (
  id                      INTEGER PRIMARY KEY,
  event_id                INTEGER NOT NULL UNIQUE REFERENCES events(id),
  ts                      INTEGER NOT NULL,
  session_id              INTEGER NOT NULL REFERENCES sessions(id),
  percent_milli           INTEGER NOT NULL,          -- '1.019%' -> 1019
  level_at_time           INTEGER,
  kind                    TEXT NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal','aa','level_up')),
  attributed_encounter_id INTEGER REFERENCES encounters(id),
  evidence_type           TEXT CHECK (evidence_type IN ('kill_proximity','user_assertion')),
  confidence              REAL
);
CREATE INDEX idx_xp_events_session ON xp_events(session_id);
CREATE INDEX idx_xp_events_encounter ON xp_events(attributed_encounter_id);

CREATE TABLE aa_events (
  id           INTEGER PRIMARY KEY,
  event_id     INTEGER NOT NULL UNIQUE REFERENCES events(id),
  ts           INTEGER NOT NULL,
  session_id   INTEGER REFERENCES sessions(id),
  ability_name TEXT NOT NULL,
  cost_points  INTEGER NOT NULL
);
CREATE INDEX idx_aa_events_session ON aa_events(session_id);

CREATE TABLE loot_events (
  id                INTEGER PRIMARY KEY,
  event_id          INTEGER NOT NULL UNIQUE REFERENCES events(id),
  ts                INTEGER NOT NULL,
  session_id        INTEGER REFERENCES sessions(id),
  item_name         TEXT NOT NULL,
  quantity          INTEGER NOT NULL DEFAULT 1,
  corpse_name       TEXT,
  mode              TEXT NOT NULL CHECK (mode IN ('kept','auto_sold')),
  sale_total_copper INTEGER                          -- NULL unless auto_sold
);
CREATE INDEX idx_loot_events_session ON loot_events(session_id);

CREATE TABLE currency_ledger (
  id           INTEGER PRIMARY KEY,
  event_id     INTEGER NOT NULL UNIQUE REFERENCES events(id),
  ts           INTEGER NOT NULL,
  session_id   INTEGER REFERENCES sessions(id),
  delta_copper INTEGER NOT NULL,                     -- signed
  reason       TEXT NOT NULL CHECK (reason IN ('auto_sell','loot_coin','vendor','other'))
);
CREATE INDEX idx_currency_ledger_session ON currency_ledger(session_id);

CREATE TABLE faction_events (
  id           INTEGER PRIMARY KEY,
  event_id     INTEGER NOT NULL UNIQUE REFERENCES events(id),
  ts           INTEGER NOT NULL,
  session_id   INTEGER REFERENCES sessions(id),
  faction_name TEXT NOT NULL,
  delta        INTEGER NOT NULL
);
CREATE INDEX idx_faction_events_session ON faction_events(session_id);

CREATE TABLE skill_events (                           -- UNVERIFIED format; schema reserved
  id         INTEGER PRIMARY KEY,
  event_id   INTEGER NOT NULL UNIQUE REFERENCES events(id),
  ts         INTEGER NOT NULL,
  session_id INTEGER REFERENCES sessions(id),
  skill_name TEXT NOT NULL,
  new_value  INTEGER
);
CREATE INDEX idx_skill_events_session ON skill_events(session_id);

-- ── §6 Analytics rollups ───────────────────────────────────────────────────
CREATE TABLE projection_state (
  projector     TEXT PRIMARY KEY,           -- 'encounter_stats', 'encounter_buckets', ...
  last_event_id INTEGER NOT NULL DEFAULT 0,
  version       INTEGER NOT NULL            -- bump to force full rebuild
);

CREATE TABLE encounter_actor_stats (
  encounter_id      INTEGER NOT NULL REFERENCES encounters(id),
  entity_id         INTEGER NOT NULL REFERENCES entities(id),
  attrib_owner_id   INTEGER REFERENCES entities(id),  -- pets roll up to owner; NULL if self
  damage_total      INTEGER NOT NULL DEFAULT 0,
  melee_damage      INTEGER NOT NULL DEFAULT 0,
  spell_damage      INTEGER NOT NULL DEFAULT 0,
  dot_damage        INTEGER NOT NULL DEFAULT 0,
  ds_damage         INTEGER NOT NULL DEFAULT 0,
  hit_count         INTEGER NOT NULL DEFAULT 0,
  miss_count        INTEGER NOT NULL DEFAULT 0,
  max_hit           INTEGER NOT NULL DEFAULT 0,
  heal_total        INTEGER NOT NULL DEFAULT 0,
  overheal_total    INTEGER NOT NULL DEFAULT 0,
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  active_stance     TEXT,
  active_invocation TEXT,
  PRIMARY KEY (encounter_id, entity_id)
);
-- The composite PK covers (encounter_id, ...) prefix lookups; these index the
-- entity/owner join columns for per-actor and pet-rollup queries (DATA_MODEL §7).
CREATE INDEX idx_eas_entity ON encounter_actor_stats(entity_id);
CREATE INDEX idx_eas_attrib_owner ON encounter_actor_stats(attrib_owner_id);

CREATE TABLE encounter_buckets (
  encounter_id INTEGER NOT NULL REFERENCES encounters(id),
  entity_id    INTEGER NOT NULL REFERENCES entities(id),
  bucket_ts    INTEGER NOT NULL,            -- unix seconds
  damage       INTEGER NOT NULL DEFAULT 0,
  healing      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (encounter_id, entity_id, bucket_ts)
);
CREATE INDEX idx_ebuckets_entity ON encounter_buckets(entity_id);
