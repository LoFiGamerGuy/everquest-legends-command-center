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
  when a later event proves the timeout elapsed. A completed log can be closed
  out with the optional, explicitly-not-core `finalizeEncounters(db, asOfTs?)`.
- **Ally identification**: a fresh line's enemy is the NPC/article-led side (or
  an `unknown` the owner attacks — a named boss); everyone else on the line is an
  ally (group-wide, ADR-4), including not-yet-classified group members. Once an
  encounter has a known enemy, THAT enemy identity — not resolver kind — drives
  attach and ally/enemy roles: the enemy's own damage/heals are never booked as
  ally output, and a later ally line against the already-open named target (both
  sides resolver-`unknown`) attaches to that encounter rather than being dropped.
  Only the log owner's pets fold to an owner (the resolver links pets to "you");
  other players' pets self-credit. Stance/invocation-at-start is bound by the
  opener event's id — i.e. `(log_file_id, seq)`, the canonical order, never `ts`
  alone — so a same-second change with a later `seq` is not mistaken for the
  opener's stance.
- **currency_ledger** records `auto_sell` (from `loot_auto_sell`) and `loot_coin`
  (from the now-verified `coin_gain` event). `vendor`/`other` reasons stay
  deferred (their line formats are still unverified — never invent a coin delta).
- **skill_events** projects the now-verified `skill_up` event
  (`skill_name` + `new_value`).
- **rebuild is always a full wipe + replay from event 1** — `rebuildProjections`
  has no `from` option (a partial-`from` wipe would delete events ≤ from and never
  reprocess them). Partial rebuild is not an M1 need.
- **Version-bump cascade**: a stored/code `version` mismatch resets the
  mismatched projector AND every projector downstream of it in the dependency
  order (later projectors read earlier ones' outputs), so a foundational bump
  forces its dependents to re-derive. A leaf bump resets only itself + trailing
  leaves.
- **`merge_into` entity overrides** are not applied (M1); `kind` and `owner` are.
- **Single-owner pass, guarded**: one resolver / entity namespace per pass is
  built from the first `log_files` row (M1 is one owner per DB). Events spanning
  more than one `log_file_id` are rejected with a clear error rather than
  silently inheriting the first file's owner; per-log-file context is a v2
  concern (run one projection DB per character, as the orchestrator does).
- **Entities/links commit with the watermark**: the entities projector's
  kind/link sync runs inside the same transaction as each batch's watermark
  advance, so a committed watermark always implies its entity/link rows.
  `entity_links` use a deterministic upsert (no delete+reinsert), so the link id
  never drifts across passes.
- `getExperimentBreakdown` bootstraps the metric mean over encounters (the
  correct resampling unit) with a per-group seeded RNG (reproducible and
  independent of row/insertion order — the query is `ORDER BY`ed and each group's
  samples are sorted), reports n + CI, and refuses a winner when the TOP-observed
  group is below `minN` or the top two CIs overlap. `weapon` /
  `difficulty` dimensions have no verified log source in M1 (empty / `unknown`).
