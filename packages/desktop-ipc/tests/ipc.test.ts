/**
 * Contract tests for @eqlcc/desktop-ipc (docs/DESKTOP_IPC_SPEC.md §5). Wires a
 * real SessionService (over the M1 chain) into a SessionIpcHost, and drives it
 * through a SessionIpcClient across an in-memory linked transport — asserting
 * view-model fidelity, correlation, error propagation, subscription semantics,
 * robustness, seam discipline, and the determinism gate.
 *
 * Fixture lines are SYNTHETIC (corpus-verified shapes, fabricated anonymous names).
 */

import { afterEach, describe, expect, it } from "vitest";

import { migrate, openDatabase, type SqlDatabase } from "@eqlcc/database";
import { DIALECT_EQL_BETA_2026_07 } from "@eqlcc/event-schema";
import { SessionService } from "@eqlcc/session-service";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as ipc from "../src/index.js";
import { SessionIpcClient, SessionIpcHost, createLinkedTransports } from "../src/index.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const OPEN_BOSS: readonly string[] = [
  "[Fri Jul 10 17:20:00 2026] You have entered Karnor's Castle.",
  "[Fri Jul 10 17:20:10 2026] Pettwo told you, 'Attacking Venril Sathir Master.'",
  "[Fri Jul 10 17:20:12 2026] You slash Venril Sathir for 45 points of damage.",
  "[Fri Jul 10 17:20:14 2026] Pettwo slashes Venril Sathir for 20 points of damage.",
  "[Fri Jul 10 17:20:16 2026] Venril Sathir slashes YOU for 25 points of damage.",
];

const tmpDirs: string[] = [];

function writeLog(lines: readonly string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eqlcc-ipc-"));
  tmpDirs.push(dir);
  const p = path.join(dir, "eqlog_Playerone_erudin.txt");
  fs.writeFileSync(p, Buffer.from(lines.map((l) => `${l}\n`).join(""), "latin1"));
  return p;
}

function appendLines(logPath: string, lines: readonly string[]): void {
  fs.appendFileSync(logPath, Buffer.from(lines.map((l) => `${l}\n`).join(""), "latin1"));
}

function freshDb(): SqlDatabase {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

function serviceFor(p: string, live = false): SessionService {
  const logFile = { path: p, characterName: "Playerone", server: "erudin", dialectId: DIALECT_EQL_BETA_2026_07 };
  return new SessionService({ db: freshDb(), logFile, live, tailer: { pollIntervalMs: 20 } });
}

/** A wired host+client pair over the same service. */
function wire(service: SessionService): { client: SessionIpcClient; host: SessionIpcHost } {
  const [uiSide, sidecarSide] = createLinkedTransports();
  const host = new SessionIpcHost(service, sidecarSide);
  const client = new SessionIpcClient(uiSide);
  return { client, host };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// ── 1. View-model fidelity ───────────────────────────────────────────────────

describe("view-model fidelity", () => {
  it("client.start() equals a direct service.start() byte-for-byte", async () => {
    const p = writeLog(OPEN_BOSS);
    const directService = serviceFor(p, true);
    const direct = directService.start();
    directService.stop();

    const { client } = wire(serviceFor(p, true));
    const viaIpc = await client.start();
    await client.stop();

    expect(JSON.stringify(viaIpc)).toBe(JSON.stringify(direct));
    // And the round-tripped view is a real live boss fight, not a stub.
    expect(viaIpc.currentEncounter?.header.name).toBe("Venril Sathir");
  });

  it("refresh / getLiveView / status round-trip", async () => {
    const { client } = wire(serviceFor(writeLog(OPEN_BOSS), true));
    await client.start();
    const refreshed = await client.refresh();
    const peeked = await client.getLiveView();
    const status = await client.status();
    await client.stop();

    expect(refreshed.character?.name).toBe("Playerone");
    expect(JSON.stringify(peeked.currentEncounter)).toBe(JSON.stringify(refreshed.currentEncounter));
    expect(status).toBe("live");
  });
});

// ── 2. Correlation ───────────────────────────────────────────────────────────

describe("correlation", () => {
  it("concurrent in-flight requests each resolve to their own result", async () => {
    const { client } = wire(serviceFor(writeLog(OPEN_BOSS), true));
    await client.start();
    // Fire three different methods concurrently; ids must not cross.
    const [view, status, peek] = await Promise.all([client.refresh(), client.status(), client.getLiveView()]);
    await client.stop();
    expect(view.character?.name).toBe("Playerone");
    expect(status).toBe("live");
    expect(peek.currentEncounter?.header.name).toBe("Venril Sathir");
  });
});

// ── 3. Error propagation ─────────────────────────────────────────────────────

describe("error propagation", () => {
  it("a service throw rejects the matching call, and the host stays alive", async () => {
    // refresh() before start() throws inside the service.
    const { client } = wire(serviceFor(writeLog(OPEN_BOSS), false));
    await expect(client.refresh()).rejects.toThrow(/before start/);

    // The host is still responsive: a subsequent start() succeeds.
    const view = await client.start();
    expect(view.currentSession).not.toBeNull();
  });
});

// ── 4. Subscription semantics ────────────────────────────────────────────────

describe("onUpdate", () => {
  it("does not fire on start, fires when a refresh advances the watermark, stops after unsubscribe", async () => {
    const logPath = writeLog(OPEN_BOSS);
    const { client } = wire(serviceFor(logPath, true));

    const seqs: number[] = [];
    const unsub = client.onUpdate((v) => seqs.push(v.watermark.seq));

    const first = await client.start();
    expect(seqs.length).toBe(0); // no fire on start

    await client.refresh(); // no new bytes → no advance → no fire
    expect(seqs.length).toBe(0);

    appendLines(logPath, ["[Fri Jul 10 17:20:22 2026] You have slain Venril Sathir!"]);
    let advanced = false;
    for (let i = 0; i < 100 && !advanced; i++) {
      await sleep(20);
      const v = await client.refresh();
      if (v.watermark.seq > first.watermark.seq) advanced = true;
    }
    expect(advanced).toBe(true);
    expect(seqs.length).toBeGreaterThanOrEqual(1);
    for (const s of seqs) expect(s).toBeGreaterThan(first.watermark.seq);

    // After unsubscribe, no further fires even if another refresh advances.
    unsub();
    const before = seqs.length;
    appendLines(logPath, ["[Fri Jul 10 17:20:23 2026] You gain experience! (4.000%)"]);
    for (let i = 0; i < 100; i++) {
      await sleep(20);
      const v = await client.refresh();
      if (v.watermark.seq > first.watermark.seq + 1) break;
    }
    await client.stop();
    expect(seqs.length).toBe(before);
  });
});

// ── 5. Robustness ────────────────────────────────────────────────────────────

describe("robustness", () => {
  it("malformed inbound messages are ignored on both endpoints", async () => {
    const [uiSide, sidecarSide] = createLinkedTransports();
    const host = new SessionIpcHost(serviceFor(writeLog(OPEN_BOSS), false), sidecarSide);
    const client = new SessionIpcClient(uiSide);
    void host;

    // Garbage delivered to the HOST (uiSide.send reaches the host's listener): no id
    // and non-JSON must be ignored, not crash it — a real request still works after.
    uiSide.send("not json at all");
    uiSide.send(JSON.stringify({ method: "status" })); // missing id
    const view = await client.start();
    expect(view.currentSession).not.toBeNull();

    // Garbage delivered to the CLIENT (sidecarSide.send reaches the client's listener)
    // must be ignored by onResponse's parse guard; a subsequent real call still resolves.
    sidecarSide.send("}{ broken");
    sidecarSide.send(JSON.stringify({ id: 9999, ok: true, result: null })); // unknown id
    await new Promise((r) => setTimeout(r, 5));
    const status = await client.status();
    expect(status).toBe("stopped");
  });

  it("a valid request with an unknown method rejects with an error, host stays alive", async () => {
    const [uiSide, sidecarSide] = createLinkedTransports();
    const host = new SessionIpcHost(serviceFor(writeLog(OPEN_BOSS), false), sidecarSide);
    void host;
    // Hand-craft a wire request with a bogus method (bypasses the typed client).
    const error = await new Promise<string>((resolve) => {
      uiSide.onMessage((raw) => {
        const res = JSON.parse(raw) as { ok: boolean; error?: string };
        if (!res.ok) resolve(res.error ?? "");
      });
      uiSide.send(JSON.stringify({ id: 1, method: "frobnicate" }));
    });
    expect(error).toMatch(/unknown IPC method/);
    // Host still alive: a real client on the same transport works afterward.
    const client = new SessionIpcClient(uiSide);
    const view = await client.start();
    expect(view.currentSession).not.toBeNull();
  });
});

// ── 6. Seam discipline & determinism ─────────────────────────────────────────

describe("seam discipline", () => {
  it("exposes only the protocol classes/factory as runtime values", () => {
    const runtime = Object.keys(ipc).filter((k) => (ipc as Record<string, unknown>)[k] !== undefined);
    expect(runtime.sort()).toEqual(["SessionIpcClient", "SessionIpcHost", "createLinkedTransports"]);
  });

  it("contains no wall-clock or randomness in src", () => {
    const srcDir = path.join(import.meta.dirname, "..", "src");
    for (const f of fs.readdirSync(srcDir)) {
      if (!f.endsWith(".ts")) continue;
      const code = fs
        .readFileSync(path.join(srcDir, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/Date\.now|Math\.random|new Date\(/);
    }
  });
});
