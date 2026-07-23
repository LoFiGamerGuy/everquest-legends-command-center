# @eqlcc/analytics

Projection writers + the analytics read/query API for EQL Command Center
(issue #20). Implements **docs/PROJECTIONS_SPEC.md**: the deterministic,
incremental, rebuildable pipeline that turns the append-only `events` table into
the sessions / zones / encounters / rollups + domain projections, plus the thin
typed read API the M2 UI consumes. Pure TS over `@eqlcc/database`,
`@eqlcc/log-parser`, `@eqlcc/event-schema` (no new external deps).

## Layout

- `src/options.ts` — all tunable derivation constants with their spec defaults
  (`SESSION_GAP_MS`, group/raid timeouts, `RAID_ALLY_THRESHOLD`,
  `XP_KILL_WINDOW_MS`, attribution min-confidence, experiment/bootstrap knobs,
  batch size).
- `src/driver.ts` — the projection driver: `rebuildProjections` /
  `updateProjections`. Reads events in `(log_file_id, seq)` order from
  `min(projection_state.last_event_id)+1`, advances each projector's watermark in
  the **same transaction** as its writes (batched), and runs one `EntityResolver`
  alongside — `observe` before attribution, replayed from scratch with
  `entity_overrides` applied first on every pass (never depends on the
  orchestrator snapshot).
- `src/projectors/` — the registry in dependency order: `entities` → `sessions`
  → `zones` → `encounters` → `encounter_actor_stats` → `encounter_buckets` →
  `domain` (xp/aa/loot/currency/faction/skill). Each projector reconstructs its
  in-memory state from already-written rows in `load()` — this is what makes an
  incremental catch-up equal a full rebuild.
- `src/combat.ts`, `src/entity-index.ts` — shared combat interpretation and the
  deterministic name → `entities.id` index.
- `src/read/` — the read API (`getSessions`, `getSessionSummary`,
  `listEncounters`, `getEncounter`, `getActorStats`, `getXpRate`, `getLoot`,
  `getCurrency`, `getFactionChanges`, `getExperimentBreakdown`). Parameterized
  SQL, plain typed records; attribution-dependent aggregates carry
  `provenance.minConfidence`.

## Rebuildability

Events are the source of truth. `session_id` / `encounter_id` are backfilled onto
the `events` row by the sessions / encounters projectors (the schema's
"assigned by the encounter engine" columns) so downstream projectors and a
partial (single-projector, version-bumped) rebuild read them from the DB without
re-deriving. A full rebuild wipes projector outputs in reverse dependency order
(nulling those `events` columns) and replays from event 1; `entities` rows are
kept (ids are re-derived deterministically and are referenced by
`entity_overrides`).

## Interpretations / deviations (flagged for HQ)

- **Lazy encounter close at end-of-pass** (spec §5 "on the next event past the
  timeout, or at end-of-pass"): an active encounter is **not** force-closed at
  end-of-pass — it stays `status='active'` and re-opens on the next batch. This
  is required for the headline incremental == rebuild guarantee (§9.2); the
  trailing encounter mirrors the trailing open session. Close is realized only
  when a later event proves the timeout elapsed.
- **Ally identification** is resolver-driven: the enemy is the NPC/article-led
  side (or an `unknown` the owner attacks — a named boss); everyone else on the
  line is an ally (group-wide, ADR-4), including not-yet-classified group members.
  Only the log owner's pets fold to an owner (the resolver links pets to "you");
  other players' pets self-credit. Stance/invocation-at-start is derived from the
  most recent change at/before `started_ts` (ts-bounded; a same-second change
  relative to `seq` is not disambiguated — rare, flagged).
- **currency_ledger records `auto_sell` only** (spec §7 "only auto_sell is
  VERIFIED"). `coin_gain` is now a verified event in `@eqlcc/event-schema`, so
  mapping it (corpse→loot_coin, merchant→vendor, item→other) is a cheap fast
  follow — deliberately deferred here to honour the spec's VERIFIED boundary.
- **skill_events writes nothing** (spec §7 reserved). `skill_up` is now verified
  in the corpus, so this projector can be activated once a fixture/decision
  lands — deferred per the ticket.
- **`merge_into` entity overrides** are not applied (M1); `kind` and `owner` are.
- **Single-owner pass**: one resolver per pass is built from the first
  `log_files` row (M1 is one active log file). Multi-file/multi-owner passes are
  a v2 concern.
- `getExperimentBreakdown` bootstraps the metric mean over encounters (the
  correct resampling unit) with a fixed seeded RNG (reproducible), reports n +
  CI, and refuses a winner below `minN` or on CI overlap. `weapon` /
  `difficulty` dimensions have no verified log source in M1 (empty / `unknown`).
