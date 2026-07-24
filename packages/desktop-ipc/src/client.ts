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
    this.lastSeq = view.watermark.seq;
    return view;
  }

  /** Catch projections up + recompute; fires onUpdate iff the watermark advanced. */
  async refresh(): Promise<LiveView> {
    const view = (await this.request("refresh")) as LiveView;
    if (view.watermark.seq !== this.lastSeq) {
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
      this.transport.send(JSON.stringify({ id, method }));
    });
  }

  private onResponse(raw: string): void {
    let res: IpcResponse;
    try {
      res = JSON.parse(raw) as IpcResponse;
    } catch {
      return; // ignore unparseable frames rather than throwing into the transport
    }
    const p = this.pending.get(res.id);
    if (p === undefined) return; // unknown / duplicate id
    this.pending.delete(res.id);
    if (res.ok) p.resolve(res.result);
    else p.reject(new Error(res.error));
  }
}
