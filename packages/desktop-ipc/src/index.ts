/**
 * @eqlcc/desktop-ipc — the transport-agnostic IPC seam (E2.2a, issue #23 → M2,
 * docs/DESKTOP_IPC_SPEC.md) between the desktop UI (`SessionIpcClient`) and the
 * Node session-service sidecar (`SessionIpcHost`), decoupled from the concrete
 * wire behind an injectable {@link IpcTransport}. Only session-service view-model
 * types cross the wire.
 */

export { SessionIpcHost } from "./host.js";
export { SessionIpcClient } from "./client.js";
export { createLinkedTransports } from "./transport.js";
export type { IpcTransport } from "./transport.js";
export type { IpcMethod, IpcRequest, IpcResponse, IpcResult } from "./protocol.js";
