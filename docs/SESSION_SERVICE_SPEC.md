# Session Service Spec (E2.1 / issue #23)

**Status:** Draft v1 (2026-07-24) · Owner: HQ · Implements: issue #23 (M2 seam)
**Depends on:** M1 (`@eqlcc/orchestrator` live/replay, `@eqlcc/analytics` read API + driver).

## 0. Why this exists

The desktop tracker (M2) must be **thin**: no parser/DB/projection logic in the UI (planning review #18). `@eqlcc/session-service` is the single typed seam between the M1 data spine and the UI. It composes the durable ingest pipeline (tailer → parser → resolver → DB), the projection driver (incremental catch-up), and the analytics read API into a small set of **UI-ready view-models**, and is the control point the Tauri IPC layer calls.

**Where the seam actually is — two sides.** The service runs on the **backend** (the Node side of the Tauri app), which owns the data layer. *Construction* is a backend concern: `SessionServiceOptions` legitimately takes a migrated `db` handle (an `@eqlcc/database` type) — that handle never crosses to the UI. *Consumption* is the UI contract: the UI receives `LiveView` and the other view-model types over IPC and imports **only** those — never `@eqlcc/database`, `@eqlcc/log-parser`, `@eqlcc/orchestrator`, or projector internals. To keep the construction surface tight, the log source and tailer options are exposed as **service-owned structural types** (`SessionLogSource`, `SessionTailerOptions`) rather than re-exported orchestrator/DB types; the only unavoidable data-layer type on the public surface is the backend `db` handle, by design.

## 1. Architecture: a caller-driven pull seam

The orchestrator's live mode ingests events into the append-only `events` table asynchronously as the log grows (Node fs tailer). The orchestrator exposes **no per-batch success callback**, and — deliberately — the service does not add internal timers or read `Date.now()`. Instead the seam is **pull-based**:

- **Ingestion (async, orchestrator-owned):** `startLive()` tails the file; committed events accumulate in `events`.
- **Projection + view (pull, caller-driven):** `refresh()` runs `updateProjections(db)` to derive the newly-ingested events, recomputes the `LiveView`, and notifies subscribers. The UI drives the cadence (a `setInterval` in the Tauri app; explicit calls in tests). This keeps the service deterministic and free of hidden clocks/timers, and cleanly separates "bytes → events" (async) from "events → view" (synchronous, on demand).

`updatedTs` in the view is the **log clock** (max event `ts`), never wall-clock, preserving the determinism invariant.

## 2. Lifecycle

```
new SessionService({ db, logFile, live?, projection?, tailer?, onError? })
service.start()      // replay existing file → updateProjections → (live? startLive : finalizeEncounters)
service.refresh()    // updateProjections(db) → recompute LiveView → fire onUpdate; returns LiveView
service.getLiveView()// recompute from current projection state (no ingest catch-up)
service.onUpdate(cb) // subscribe; returns unsubscribe
service.stop()       // stop tailer; release handles (idempotent)
```

- **`start()`** replays the existing file to the head (deterministic, resumable via the persisted watermark), catches projections up once, then: if `live`, begins tailing (encounters stay `active` for the live tracker); if not `live` (static load of a complete log), terminal-closes encounters via `finalizeEncounters(db)` so a finished log shows every encounter closed.
- **`refresh()`** is the live heartbeat: catch projections up to the ingested head, recompute, notify. Idempotent when the watermark hasn't advanced (returns the same view; fires no update).
- **`stop()`** stops the tailer and is safe to call repeatedly; a stopped/errored service still answers `getLiveView()` from the last projection state.

## 3. Status model

`ServiceStatus = "idle" | "replaying" | "live" | "stopped" | "error"`, derived from the pipeline mode plus `lastError`. A live-tailing halt (truncation/rotation — orchestrator halts live on those, rotation-reset is #20) or a consumer error surfaces as `status: "error"` with `lastError` set; the last good view remains readable. Errors are surfaced, never thrown from `refresh()`.

## 4. View-models (the UI contract)

```ts
interface LiveView {
  status: ServiceStatus;
  lastError: string | null;
  watermark: { byteOffset: number; seq: number };
  updatedTs: number | null;                 // log clock (max event ts), deterministic
  character: { entityId: number; name: string | null } | null;
  currentSession: SessionSummary | null;    // the open session, else the latest
  currentEncounter: EncounterView | null;   // the active encounter in the current session, if any
  recentEncounters: EncounterHeader[];       // closed encounters in the current session, newest-first, ≤ recentLimit
}

interface EncounterView {
  header: EncounterHeader;
  actors: ActorStatsRow[];   // owner-folded, ranked by dps desc then entityId (stable)
  provenance: Provenance;    // minConfidence surfaced so the UI never renders a guess as fact
}
```

Derivation rules (all deterministic, all delegated to the analytics read API — the service adds shaping only, never new aggregation):

- **currentSession:** the session with `endedTs === null` (there is at most one — single owner file); else the session with the greatest `startedTs`. `null` if there are no sessions.
- **character:** `currentSession.characterEntityId` resolved to a name via the `entities` canonical name; `null` when unknown.
- **currentEncounter:** the `status === "active"` encounter in the current session, if any (the encounter projector can keep several active at once, keyed by enemy, so the most-recently-active one — greatest last-activity ts — is chosen, deterministic tiebreak by startedTs then id). Its `actors` come from `getActorStats({ encounterId, foldPets: true })`, ranked by `dps` desc then `entityId` asc for a stable order; enemies are never actors (the read API already excludes them). `null` when no encounter is active.
- **recentEncounters:** `listEncounters({ sessionId })` filtered to `status === "closed"`, newest-first, capped at `recentLimit` (default 10).

The service re-exports `SessionSummary`, `EncounterHeader`, `ActorStatsRow`, `Provenance` from `@eqlcc/analytics` unchanged, plus `LiveView` / `EncounterView` / `ServiceStatus`. No DB/parser types cross the seam.

## 5. Guarantees & tests (contract)

- **Thin seam:** the package's public surface exposes only view types + the service class; a structural test asserts no `@eqlcc/database` / `@eqlcc/log-parser` symbol is re-exported.
- **Determinism:** two independent `start()`s over the same static log yield byte-identical `LiveView` JSON (the shaping is a pure function of projection state; `updatedTs` is log-clock).
- **Attribution honesty end-to-end:** in a fixture with a pet + a named enemy that hits back, `currentEncounter.actors` fold the pet into its owner, never list the enemy, and `provenance.minConfidence > 0`; the owner is the top actor.
- **Live heartbeat:** feeding a growing file + `refresh()` between grows advances the watermark, moves an encounter from `currentEncounter` (active) to `recentEncounters` (closed) once a timeout gap lands, and fires `onUpdate` exactly when the watermark advances.
- **Static vs live:** a static `start()` (`live:false`) terminal-closes all encounters (`currentEncounter === null`); a live `start()` leaves the last encounter active.
- **Idempotent refresh:** `refresh()` with no new bytes returns an equal view and fires no `onUpdate`.
- **No hidden clock:** no `Date.now` / `Math.random` / `new Date` in the package (grep-asserted, matching the repo determinism gate).

## 6. Out of scope (later M2 tickets)

Tauri shell + IPC wiring (E2.2), overlay/dashboard rendering (E2.4+), export (E2.7), settings persistence. This package is headless and UI-agnostic; it is consumed over IPC. Multi-file / multi-character tracking follows the projections' documented single-owner-file v2 scope.
