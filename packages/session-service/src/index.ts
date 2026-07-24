/**
 * @eqlcc/session-service — the thin, typed M2 seam (issue #23,
 * docs/SESSION_SERVICE_SPEC.md). The single control point the desktop tracker
 * consumes over IPC: it composes the durable ingest pipeline, the projection
 * driver, and the analytics read API into UI-ready live view-models.
 *
 * The UI imports ONLY the view types + the service class from here — never
 * `@eqlcc/database`, `@eqlcc/log-parser`, `@eqlcc/orchestrator`, or projector
 * internals. Aggregate view-model types are re-exported unchanged from
 * `@eqlcc/analytics` for convenience.
 */

export { SessionService } from "./service.js";
export type { SessionServiceOptions } from "./service.js";

export type { LiveView, EncounterView, ServiceStatus } from "./view.js";

// Re-exported unchanged from the analytics read API so the UI has one import.
export type {
  SessionSummary,
  EncounterHeader,
  ActorStatsRow,
  Provenance,
} from "@eqlcc/analytics";
