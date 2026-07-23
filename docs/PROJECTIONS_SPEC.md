# Projections & Analytics Derivation Spec

**Status:** Draft v1 (2026-07-23) · Owner: HQ · Implements: issue #20 (projection writers)
**Companion to:** docs/DATA_MODEL.md (§4–§6 define the *tables*; this doc defines *how events become rows*) and docs/ARCHITECTURE.md (pipeline stage: SQLite projections → analytics).

The database schema already defines every projection table (migration 0001). This spec defines the **derivation rules, segmentation boundaries, attribution, rebuildability, and the read/query API** — the contract the projection writers implement and the analytics/UI layers consume. Where a rule rests on an unverified log fact, it is marked **UNVERIFIED** and defaults to null/user-supplied, never guessed.

## 0. Principles

1. **Events are the source of truth; every projection is a pure, deterministic function of the `events` table.** A full rebuild from `events` must reproduce byte-identical projection rows. No projection holds information that isn't derivable from events (+ `entity_overrides` for user corrections).
2. **Order is `(log_file_id, seq)`, never `ts` alone** (DATA_MODEL ordering amendment). Same-second events are common; `seq` is the tiebreak.
3. **No silent guesses.** Attribution and membership carry `evidence_type` + `confidence`; uncertain attribution is surfaced, not hidden. Pets roll up to owners only via resolver evidence.
4. **Incremental and rebuildable.** Each projector tracks progress in `projection_state.last_event_id`; a `version` bump wipes its outputs and rebuilds from `last_event_id = 0`. Incremental application of events `> last_event_id` must yield the same result as a full rebuild (tested).
5. **Money is integer copper; percentages are integer milli-percent; the only float is `confidence` (0–1).**

## 1. Projector architecture

A **projector** is `{ name, version, tablesOwned[], apply(db, event, ctx), reset(db) }`. The driver:
- reads `events` in `(log_file_id, seq)` order starting at `min(projection_state.last_event_id)+1` across active projectors;
- for each event, calls each projector whose `version` matches `projection_state.version` (else that projector is reset first);
- advances `projection_state.last_event_id` to the processed `event.id` **in the same transaction** as the projector writes (same invariant as ingestion: never advance the projector watermark without its writes);
- runs the whole pass inside batched transactions for throughput.

A single **resolver instance** (`@eqlcc/log-parser` `EntityResolver`) is advanced alongside the projectors: every event is `resolver.observe(event)`d before attribution so pet/owner links are current. On a full rebuild the resolver starts empty and is replayed from event 1 (deterministic); `entity_overrides` (user corrections) are applied to it first so user assertions win. **Projections therefore never depend on the orchestrator's persisted snapshot** — they re-derive attribution from events, which keeps them independently rebuildable.

Projector registry (M1 scope, in dependency order): `entities` → `sessions` → `zones` → `encounters` → `encounter_actor_stats` → `encounter_buckets` → `domain` (xp/aa/loot/currency/faction/skill). Later projectors read rows written by earlier ones within the same pass.

## 2. Entities & attribution (feeds everything)

- Every actor/target name observed is upserted into `entities` (kind from the resolver: player/pet/npc/merc/unknown). `entity_links` (pet→owner) and `entity_overrides` (user corrections) mirror the resolver snapshot shape and are written from the live resolver state.
- **Attribution helper:** for a combat event, `resolver.attributeSource(event)` returns `{ entityId, ownerId?, confidence }`. The **actor row** in `encounter_actor_stats` is keyed by the *actual actor* `entityId`; `attrib_owner_id = ownerId` when the actor is a pet with an active owner link (else NULL). This preserves both views: per-pet detail and owner rollup. **Owner-folded totals** are the query `GROUP BY COALESCE(attrib_owner_id, entity_id)`.
- Attribution is **never** applied below the resolver's attribution threshold (0.5); sub-threshold actors credit themselves, not a guessed owner.
- `events.source_entity_id` / `target_entity_id` FK backfill is **optional** in M1 (the projectors attribute in-place during rollup). If implemented, it is an `UPDATE` of nullable FK columns only (not a mutation of the event fact) and must be idempotent. Deferred unless cheap.

## 3. Sessions (`sessions`, one+ per log file)

- **Open:** the first event of a log file opens a session (`started_ts = event.ts`, `character_entity_id` = the log owner from the filename).
- **Close:** a session closes when (a) a `LogToggle(off)` event occurs, or (b) the gap between consecutive event `ts` exceeds **`SESSION_GAP_MS` = 30 min** (configurable). `ended_ts` = the last event before the gap. The next event opens a new session. Live/EOF: the trailing session stays open (`ended_ts` NULL).
- Rationale for 30 min: separates play sessions across breaks without splitting normal downtime; matches the "active vs AFK" model in §7. Configurable so users can tune.

## 4. Zones (`zones`, `zone_visits`)

- Each `ZoneEnter` event upserts `zones(name)` and closes the current `zone_visits` row (`left_ts = event.ts`) then opens a new one for the current session.
- `is_instance` heuristic (**UNVERIFIED**): 1 if the zone name ends in `Expedition` (observed pattern, e.g. "New Sebilis Expedition"); else 0. Flagged for correction; never load-bearing.

## 5. Encounters (`encounters`, `encounter_participants`) — the core segmentation

An **encounter** groups combat around a single enemy target over a contiguous window. Group-wide (ADR-4): once open, *all* combat involving that target attaches, not just the log owner's.

- **Open:** a combat event (`melee_hit`/`melee_miss`/`spell_damage`/`dot_tick`/`damage_shield`/`kill`) whose *enemy* participant has no active encounter opens one. `primary_target_entity_id` = the enemy; `name` = the enemy's display name, or `Trash: <zone>` when the enemy is an unnamed/`a `/`an `-prefixed trash mob; `started_ts` = event.ts; `status='active'`.
  - **Enemy identification:** the enemy is the combat participant that is not the log owner, not an ally (see participants), and not a pet of an ally. Same-name mobs are indistinguishable in EQ logs (documented limitation, PRIOR_ART): concurrent combat against the same enemy *name* folds into one encounter. This is a known imprecision, surfaced not hidden.
- **Attach:** every subsequent combat event sharing the encounter's enemy (as attacker or target), plus heals on encounter allies within the window, attaches to the active encounter and updates `ended_ts` to that event's `ts` (**back-dated to the last combat event**, per schema — not the timeout expiry).
- **Close:** the encounter closes when no attaching event has arrived for **`timeout`** since `ended_ts`: `group` scale ⇒ **15 s**, `raid` scale ⇒ **2 min** (rumstil FightTracker precedent). Closing is lazy (on the next event past the timeout, or at end-of-pass).
- **Scale:** default `group`; escalate to `raid` when the encounter's distinct **ally** participant count exceeds **`RAID_ALLY_THRESHOLD` = 6** (heuristic; raises the idle timeout so long raid fights don't split). Documented heuristic.
- **`difficulty_tier`:** NULL by default — **UNVERIFIED** source (EQL Tools segments by D0–D4, so it is derivable, but the log marker is not yet confirmed; RESEARCH_BACKLOG). User- or heuristic-set later; never guessed.
- **`active_stance` / `active_invocation`:** the log owner's stance/invocation in effect at `started_ts`, i.e. the most recent `stance_change` / `invocation_change` event at or before the encounter open. These are the A/B analytics dimensions (ADR-10).
- **Participants** (`encounter_participants`): each distinct entity seen in the encounter with `role` ∈ ally/enemy/unknown and `evidence_type` ∈ dealt_damage/took_damage/healed_ally/was_healed/pet_of_ally/user_assertion + `confidence`. The log owner and its pets and anyone healing/healed-with them are `ally`; the primary target and things that only take the group's damage are `enemy`; ambiguous is `unknown`. Membership is evidence-based like all attribution.

## 6. Combat rollups (`encounter_actor_stats`, `encounter_buckets`)

For each attaching combat event, credit the attributed actor (§2):
- `damage_total` and the split columns `melee_damage` / `spell_damage` / `dot_damage` / `ds_damage` by event type; `hit_count` / `miss_count`; `max_hit`.
- Heals (`heal`): `heal_total` += capped amount; `overheal_total` += `max(0, uncapped − capped)` when the uncapped parenthetical is present.
- `duration_ms` = encounter span (`ended_ts − started_ts`); **DPS = `damage_total / (duration_ms/1000)`**, HPS analogous. (Per-actor active time is a v2 refinement; M1 uses encounter span, the community-standard denominator — see PRIOR_ART GamParse convention.)
- `active_stance` / `active_invocation` copied from the encounter (the owner's; per-actor stance is not observable for allies).
- `encounter_buckets`: per-(encounter, entity, `bucket_ts`=unix second) `damage` / `healing` for live meters and charts. Prunable for old encounters, rebuildable.

## 7. Domain projections (§5 tables) & session analytics

Mostly 1:1 from their verified event types, each row referencing its source `event_id` (UNIQUE — idempotent):
- **`xp_events`:** from `xp_gain` (`kind='normal'`), `level_up` (`kind='level_up'`), AA xp (`kind='aa'` — UNVERIFIED, reserve). `percent_milli` lossless. `attributed_encounter_id` = the nearest preceding `kill`'s encounter within **`XP_KILL_WINDOW_MS` = 5 s** (`evidence_type='kill_proximity'`, `confidence` by proximity); else NULL. Enables XP/kill and XP/hour.
- **`aa_events`:** from `ability_purchase` (name + `cost_points`, both verified in-log).
- **`loot_events`:** from loot events — `mode='kept'` (corpse loot) or `'auto_sold'` (`sale_total_copper` set). `quantity`, `corpse_name` when present.
- **`currency_ledger`:** signed `delta_copper` with `reason` — only `auto_sell` is VERIFIED; `loot_coin`/`vendor`/`other` as their formats are confirmed (RESEARCH_BACKLOG). Never invent coin deltas.
- **`faction_events`:** `faction_name` + `delta` (positive verified; negative assumed symmetric).
- **`skill_events`:** **UNVERIFIED** format — projector reserved, writes nothing until a fixture lands.
- **Session analytics** (computed, not a table in M1 — exposed via query API §8): `active_ms` = Σ encounter `duration_ms` in the session; `afk_ms` = session span − active_ms; XP/hour = Σ `percent_milli` per level ÷ session hours; coin/hour from `currency_ledger`.

## 8. Read / query API (what analytics & the M2 UI consume)

The projections package exports a thin, typed read API (parameterized SQL, no ORM) — the seam that keeps the UI thin (ARCHITECTURE):

- `rebuildProjections(db, {from?})` / `updateProjections(db)` — full rebuild / incremental to head.
- `getSessions(db, logFileId?)`, `getSessionSummary(db, sessionId)` → span, active/afk ms, xp/hr, coin/hr, encounter count, zones.
- `listEncounters(db, {sessionId?, zoneId?, scale?, since?})` → encounter headers (name, target, span, dps of top actor).
- `getEncounter(db, encounterId)` → participants + per-actor stats (with owner-folded and per-pet views) + bucket series for charts.
- `getActorStats(db, {encounterId?|sessionId?, foldPets=true})` → damage/heal/tank breakdown; folded by `COALESCE(attrib_owner_id, entity_id)` when `foldPets`.
- `getXpRate(db, sessionId)`, `getLoot(db, {sessionId?})`, `getCurrency(db, {sessionId?})`, `getFactionChanges(db, sessionId)`.
- `getExperimentBreakdown(db, {dimension:'stance'|'invocation'|'weapon'|'zone'|'difficulty', metric:'dps'|'hps'|'xp_per_hr'})` → grouped aggregates with **n (encounters/hits) and a bootstrap CI**, refusing a winner below minimum n (EXPERIMENT_DESIGN). This is the A/B backbone.

All read functions return plain typed records; every aggregate that rests on attribution carries the min `confidence` in its provenance so the UI never renders a guess as fact.

## 9. Rebuild / correctness guarantees (tested)

1. **Determinism:** `rebuildProjections` over a fixture event set yields byte-identical rows across runs and machines (UTC, `(log_file_id, seq)` order).
2. **Incremental == rebuild:** applying events in arbitrary batch splits via `updateProjections` equals a single full rebuild (projection_state watermark correctness).
3. **Version bump ⇒ clean rebuild:** bumping a projector `version` wipes exactly its tables and rebuilds, leaving others untouched.
4. **Idempotency:** re-running `updateProjections` at head is a no-op (watermark + `event_id` UNIQUE on domain rows).
5. **Attribution honesty:** a pet's damage folds to its owner only with an active resolver link; a user `entity_override` re-classifying it as non-pet removes the fold on the next rebuild.
6. **Encounter segmentation:** group/raid timeout, back-dated `ended_ts`, trash-vs-named naming, and stance/invocation-at-start are asserted on synthetic multi-actor fixtures.

## 10. Open questions (RESEARCH_BACKLOG)

`difficulty_tier` log source; charmed-pet vs same-name-NPC disambiguation; coin-loot (non-auto-sell) line formats; skill-up line format; instanced-zone detection beyond the `Expedition` suffix; per-actor active-time (vs encounter span) for v2 DPS. None block M1 projections; each defaults to null/user-supplied.
