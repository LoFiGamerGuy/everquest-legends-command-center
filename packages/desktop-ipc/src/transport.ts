/**
 * The transport seam (docs/DESKTOP_IPC_SPEC.md §2). A concrete transport (E2.2b)
 * implements this over the sidecar's stdio or a localhost socket; the host and
 * client depend only on this interface. `createLinkedTransports` returns an
 * in-memory pair (each `send` delivers to the peer on a microtask, mimicking real
 * async IPC) — the contract-test wire and the reference semantics a real
 * transport must honor. No wall-clock, no timers.
 */

export interface IpcTransport {
  /** Send one serialized JSON message to the peer. */
  send(message: string): void;
  /** Register the single inbound-message listener. */
  onMessage(listener: (message: string) => void): void;
}

class LinkedTransport implements IpcTransport {
  private listener: ((message: string) => void) | null = null;
  /** Set by the factory to the peer's deliver function. */
  deliverToPeer: (message: string) => void = () => {};

  send(message: string): void {
    const deliver = this.deliverToPeer;
    // Deliver asynchronously so send() never re-enters the caller synchronously,
    // matching a real stdio/socket wire (and avoiding reentrancy surprises).
    queueMicrotask(() => deliver(message));
  }

  onMessage(listener: (message: string) => void): void {
    this.listener = listener;
  }

  receive(message: string): void {
    this.listener?.(message);
  }
}

/** An in-memory transport pair: whatever one sends, the other receives. */
export function createLinkedTransports(): [IpcTransport, IpcTransport] {
  const a = new LinkedTransport();
  const b = new LinkedTransport();
  a.deliverToPeer = (m) => b.receive(m);
  b.deliverToPeer = (m) => a.receive(m);
  return [a, b];
}
