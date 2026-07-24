/**
 * SessionIpcHost — the sidecar-side dispatcher (docs/DESKTOP_IPC_SPEC.md §3).
 * Wraps a {@link SessionService} and, per inbound request, calls the matching
 * method and replies. A thrown service error becomes an `ok:false` response — the
 * host never crashes. Malformed inbound JSON (or a message with no numeric `id`)
 * is ignored, since no correlated reply is possible. Holds no state but the
 * service; a thin, transport-agnostic adapter.
 */

import type { SessionService } from "@eqlcc/session-service";

import type { IpcMethod, IpcRequest, IpcResult } from "./protocol.js";
import type { IpcTransport } from "./transport.js";

export class SessionIpcHost {
  private readonly service: SessionService;
  private readonly transport: IpcTransport;

  constructor(service: SessionService, transport: IpcTransport) {
    this.service = service;
    this.transport = transport;
    this.transport.onMessage((raw) => this.handle(raw));
  }

  private handle(raw: string): void {
    const req = parseRequest(raw);
    if (req === null) return; // malformed / no id — cannot correlate a reply
    try {
      const result = this.dispatch(req.method);
      this.reply({ id: req.id, ok: true, result });
    } catch (e) {
      this.reply({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private dispatch(method: IpcMethod): IpcResult {
    switch (method) {
      case "start":
        return this.service.start();
      case "refresh":
        return this.service.refresh();
      case "getLiveView":
        return this.service.getLiveView();
      case "status":
        return this.service.status;
      case "stop":
        this.service.stop();
        return null;
      default:
        throw new Error(`@eqlcc/desktop-ipc: unknown IPC method '${String(method)}'`);
    }
  }

  private reply(response: { id: number; ok: true; result: IpcResult } | { id: number; ok: false; error: string }): void {
    try {
      this.transport.send(JSON.stringify(response));
    } catch {
      // A send failure on a dead wire must not escape the inbound callback — the
      // host "never crashes" (spec §3). Disconnect handling belongs to the
      // concrete transport (spec §6); there is no error hook to route to yet.
    }
  }
}

/** Parse+validate an inbound request; returns null when it cannot be correlated. */
function parseRequest(raw: string): IpcRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  if (typeof rec["id"] !== "number" || typeof rec["method"] !== "string") return null;
  return { id: rec["id"], method: rec["method"] as IpcMethod };
}
