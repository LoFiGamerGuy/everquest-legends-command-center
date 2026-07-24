/**
 * SessionIpcClient — the UI-side proxy (docs/DESKTOP_IPC_SPEC.md §4). Exposes
 * async methods mirroring the {@link SessionService}; each request gets a fresh
 * id and a pending promise resolved when the correlated response arrives. An
 * `ok:false` response rejects with the service's message. `onUpdate` mirrors the
 * service's pull-model semantics client-side: `start()` records the initial
 * watermark without firing; each `refresh()` that advances `watermark.seq` fires
 * subscribers once. No wall-clock, no timers.
 */

import type { LiveView, ServiceStatus } from "@eqlcc/session-service";

import type { IpcMethod, IpcResponse, IpcResult } from "./protocol.js";
import type { IpcTransport } from "./transport.js";

type Pending = { resolve: (r: IpcResult) => void; reject: (e: Error) => void };
type Subscriber = (view: LiveView) => void;

export class SessionIpcClient {
  private readonly transport: IpcTransport;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly subscribers = new Set<Subscriber>();
  private lastSeq = -1;

  constructor(transport: IpcTransport) {
    this.transport = transport;
    this.transport.onMessage((raw) => this.onResponse(raw));
  }

  /** Ingest + (for live) begin tailing; returns the first view (does not fire onUpdate). */
  async start(): Promise<LiveView> {
    const view = (await this.request("start")) as LiveView;
    this.lastSeq = Math.max(this.lastSeq, view.watermark.seq);
    return view;
  }

  /** Catch projections up + recompute; fires onUpdate iff the watermark advanced. */
  async refresh(): Promise<LiveView> {
    const view = (await this.request("refresh")) as LiveView;
    // Watermark is MONOTONIC: fire only on a strict advance, and never regress
    // lastSeq. With a real async transport two refreshes can be in flight and
    // their responses arrive out of order; a stale (older-seq) response must not
    // re-fire or move lastSeq backward.
    if (view.watermark.seq > this.lastSeq) {
      this.lastSeq = view.watermark.seq;
      for (const cb of this.subscribers) cb(view);
    }
    return view;
  }

  /** Recompute from current projection state (no catch-up). */
  async getLiveView(): Promise<LiveView> {
    return (await this.request("getLiveView")) as LiveView;
  }

  /** Current service status. */
  async status(): Promise<ServiceStatus> {
    return (await this.request("status")) as ServiceStatus;
  }

  /** Stop live tailing on the sidecar. */
  async stop(): Promise<void> {
    await this.request("stop");
  }

  /** Subscribe to watermark-advancing refreshes; returns an unsubscribe. */
  onUpdate(cb: Subscriber): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  private request(method: IpcMethod): Promise<IpcResult> {
    const id = this.nextId++;
    return new Promise<IpcResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.transport.send(JSON.stringify({ id, method }));
      } catch (e) {
        // A real wire can throw synchronously (closed pipe): don't leak the
        // pending entry — drop it and reject the caller with the send error.
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private onResponse(raw: string): void {
    const res = parseResponse(raw);
    if (res === null) return; // ignore unparseable / structurally-invalid frames
    const p = this.pending.get(res.id);
    if (p === undefined) return; // unknown / duplicate id
    this.pending.delete(res.id);
    if (res.ok) p.resolve(res.result);
    else p.reject(new Error(res.error));
  }
}

/**
 * Validate an inbound frame before it touches `pending`. A bare `"null"` parses
 * as `null` (so `res.id` would throw out of the transport callback), and a frame
 * with a matching id but no `ok`/`error` could resolve `undefined` or reject with
 * `Error(undefined)`; both are rejected here instead (spec §4 robustness).
 */
function parseResponse(raw: string): IpcResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  if (typeof rec["id"] !== "number" || !Number.isSafeInteger(rec["id"])) return null;
  if (rec["ok"] === true && "result" in rec) {
    return { id: rec["id"], ok: true, result: rec["result"] as IpcResult };
  }
  if (rec["ok"] === false && typeof rec["error"] === "string") {
    return { id: rec["id"], ok: false, error: rec["error"] };
  }
  return null;
}
