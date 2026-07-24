/**
 * The desktop IPC wire protocol (docs/DESKTOP_IPC_SPEC.md §1). Messages are JSON
 * strings; requests carry a monotonic `id` the response echoes. Only the
 * session-service view-model types cross the wire — the thin-seam invariant holds
 * across the transport, just as it does across the service boundary.
 */

import type { LiveView, ServiceStatus } from "@eqlcc/session-service";

/** The service methods exposed over IPC. */
export type IpcMethod = "start" | "refresh" | "getLiveView" | "status" | "stop";

/** A UI→sidecar request. */
export interface IpcRequest {
  id: number;
  method: IpcMethod;
}

/** The result payload for a method (`stop` → null). */
export type IpcResult = LiveView | ServiceStatus | null;

/** A sidecar→UI response, correlated by `id`. */
export type IpcResponse =
  | { id: number; ok: true; result: IpcResult }
  | { id: number; ok: false; error: string };
