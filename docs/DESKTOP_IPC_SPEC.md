# Desktop IPC Spec (E2.2a / issue #23 → M2)

**Status:** Draft v1 (2026-07-24) · Owner: HQ · Part of: M2 desktop tracker
**Depends on:** `@eqlcc/session-service` (the view-model seam).

## 0. Why this exists (and the architecture reality)

The M1 data spine — parser, resolver, SQLite (`better-sqlite3`, a native **Node** module), projections, and the `@eqlcc/session-service` seam — is TypeScript running on **Node**. A Tauri 2 app's backend is **Rust**, and its UI (React) runs in a webview where a native Node SQLite module cannot run. So the desktop app runs the TS spine as a **Node sidecar** the Tauri shell launches; the React UI talks to that sidecar.

`@eqlcc/desktop-ipc` is the **transport-agnostic seam** between the UI (a `SessionIpcClient`) and the sidecar (a `SessionIpcHost` wrapping a `SessionService`). It defines a small JSON message protocol and both endpoints, decoupled from the concrete wire (stdio pipe, localhost socket, or a Rust `invoke` proxy) behind an injectable `IpcTransport`. This lets the hard part — the typed request/response contract and its round-trip guarantees — be built and tested now in pure TS, while the concrete Tauri transport + window boot (**E2.2b**) is wired and verified on the device where the Rust toolchain and a display exist.

## 1. Protocol

Messages are JSON strings (stdio/socket/postMessage friendly). Requests carry a monotonic `id`; responses echo it.

```ts
type IpcMethod = "start" | "refresh" | "getLiveView" | "status" | "stop";
interface IpcRequest  { id: number; method: IpcMethod }
type IpcResponse =
  | { id: number; ok: true;  result: LiveView | ServiceStatus | null }
  | { id: number; ok: false; error: string };
```

Result mapping: `start`/`refresh`/`getLiveView` → `LiveView`; `status` → `ServiceStatus`; `stop` → `null`. The wire carries only the session-service's view-model types — never DB/parser/orchestrator types (the thin-seam invariant continues across the wire).

## 2. Transport

```ts
interface IpcTransport {
  send(message: string): void;
  onMessage(listener: (message: string) => void): void; // single inbound listener
}
```

A concrete transport (E2.2b) implements this over the sidecar's stdio or a localhost socket. `createLinkedTransports()` returns an in-memory pair whose `send` delivers to the peer's listener on a microtask (mimicking real async IPC) — used by the contract tests and as the reference semantics a real transport must honor. No wall-clock/timers.

## 3. Host (sidecar side)

`SessionIpcHost(service, transport)` registers one inbound listener and, per request, calls the matching `SessionService` method and replies:
- Success → `{ id, ok: true, result }`.
- A thrown service error (e.g. `refresh()` before `start()`, or a replay failure) → `{ id, ok: false, error: message }` — **never** crashes the host.
- Malformed inbound JSON, or a message with no `id`, is ignored (no reply is possible without a correlation id).

The host holds no state beyond the service; it is a thin dispatcher. `stop` forwards to `service.stop()` and replies `null`.

## 4. Client (UI side)

`SessionIpcClient(transport)` exposes async methods mirroring the service: `start()`, `refresh()`, `getLiveView()` → `Promise<LiveView>`; `status()` → `Promise<ServiceStatus>`; `stop()` → `Promise<void>`. Each assigns a fresh `id`, registers a pending promise, sends the request, and resolves/rejects when the correlated response arrives; an `ok:false` response rejects with an `Error(message)`.

`onUpdate(cb)` mirrors the service's semantics **client-side** (the pull model needs no server push): `start()` records the initial watermark **without** firing; each `refresh()` whose response advances `watermark.seq` fires subscribers exactly once. Returns an unsubscribe.

Unknown/duplicate response ids are ignored (a late duplicate cannot resolve twice). A response that fails to parse is ignored rather than throwing into the transport callback.

## 5. Guarantees & tests (contract)

- **View-model fidelity:** a `client.start()`/`refresh()`/`getLiveView()` result is byte-identical (`JSON.stringify`) to the same call made directly on an identically-constructed service+DB — the IPC layer mangles nothing.
- **Correlation:** concurrent in-flight requests each resolve to their own correct result (ids are not crossed).
- **Error propagation:** a service throw (e.g. `refresh` before `start`) rejects the corresponding client call with the service's message; the host stays alive and still answers later requests.
- **Subscription semantics:** `onUpdate` does not fire on `start`, fires exactly when a `refresh` advances the watermark (driven by a live append), and stops after unsubscribe.
- **Robustness:** malformed inbound messages on either endpoint are ignored, not fatal.
- **Thin seam preserved:** the package's public surface exposes only the protocol types, the transport interface + factory, and the host/client classes — no DB/parser type crosses it (runtime-export guard).
- **Determinism gate:** no `Date.now`/`Math.random`/`new Date` in `src`.

## 6. Out of scope (E2.2b, device)

The concrete Tauri transport (sidecar spawn + stdio/socket wiring, Rust window/IPC glue), the React UI that consumes `SessionIpcClient`, app boot, and packaging. Reconnect/backpressure/heartbeat on a real transport, and multi-client fan-out, are later hardening. This package is headless and UI-agnostic.
