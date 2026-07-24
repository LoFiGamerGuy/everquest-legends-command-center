/**
 * Contract tests for @eqlcc/session-service (issue #23,
 * docs/SESSION_SERVICE_SPEC.md §5). Drives the real M1 chain (orchestrator →
 * database → analytics) through the service over synthetic logs, asserting the
 * view-model contract, attribution honesty, the live heartbeat, and determinism.
 *
 * The fixture lines are SYNTHETIC — assembled from corpus-verified recognizer
 * shapes with fabricated anonymous names (CLAUDE.md: never a real player log).
 */

import { afterEach, describe, expect, it } from "vitest";

import { migrate, openDatabase, type SqlDatabase } from "@eqlcc/database";
import { DIALECT_EQL_BETA_2026_07 } from "@eqlcc/event-schema";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as serviceModule from "../src/index.js";
import { SessionService, type SessionLogSource } from "../src/index.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A boss fight left OPEN (no kill, no gap) so the encounter stays active. */
const OPEN_BOSS: readonly string[] = [
  "[Fri Jul 10 17:20:00 2026] You have entered Karnor's Castle.",
  "[Fri Jul 10 17:20:10 2026] Pettwo told you, 'Attacking Venril Sathir Master.'",
  "[Fri Jul 10 17:20:12 2026] You slash Venril Sathir for 45 points of damage.",
  "[Fri Jul 10 17:20:14 2026] Pettwo slashes Venril Sathir for 20 points of damage.",
  "[Fri Jul 10 17:20:16 2026] Venril Sathir slashes YOU for 25 points of damage.",
];

/**
 * TWO encounters active AT ONCE (both within the 15 s timeout, neither killed):
 * an older-started beetle pull, then a Venril pull whose last activity is later.
 * The "current" fight is Venril (latest activity), NOT the oldest-started beetle.
 */
const TWO_ACTIVE: readonly string[] = [
  "[Fri Jul 10 17:20:00 2026] You have entered Karnor's Castle.",
  "[Fri Jul 10 17:20:02 2026] You slash a fire beetle for 8 points of damage.",
  "[Fri Jul 10 17:20:04 2026] You slash Venril Sathir for 10 points of damage.",
  "[Fri Jul 10 17:20:06 2026] You slash Venril Sathir for 7 points of damage.",
];

/** Two encounters in ONE session (68 s gap > 15 s encounter timeout, < 30 min session gap). */
const TWO_ENCOUNTERS: readonly string[] = [
  ...OPEN_BOSS,
  "[Fri Jul 10 17:20:22 2026] You have slain Venril Sathir!",
  "[Fri Jul 10 17:20:22 2026] You gain experience! (4.000%)",
  "[Fri Jul 10 17:21:30 2026] You slash a fire beetle for 8 points of damage.",
  "[Fri Jul 10 17:21:32 2026] a fire beetle slashes YOU for 3 points of damage.",
  "[Fri Jul 10 17:21:34 2026] You have slain a fire beetle!",
  "[Fri Jul 10 17:21:34 2026] You gain experience! (1.000%)",
];

const tmpDirs: string[] = [];

function writeLog(lines: readonly string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eqlcc-svc-"));
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

function logFile(p: string): SessionLogSource {
  return { path: p, characterName: "Playerone", server: "erudin", dialectId: DIALECT_EQL_BETA_2026_07 };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// ── 1. Static load ───────────────────────────────────────────────────────────

describe("static load (live:false)", () => {
  it("shapes the session, resolves the character, and closes every encounter", () => {
    const db = freshDb();
    const svc = new SessionService({ db, logFile: logFile(writeLog(TWO_ENCOUNTERS)), live: false });
    const view = svc.start();

    expect(svc.status).toBe("stopped");
    expect(view.status).toBe("stopped");
    expect(view.character?.name).toBe("Playerone");
    expect(view.currentSession).not.toBeNull();
    expect(view.currentSession?.encounterCount).toBe(2);
    // A completed log shows no active encounter and lists both closed, newest-first.
    expect(view.currentEncounter).toBeNull();
    expect(view.recentEncounters.length).toBe(2);
    expect(view.recentEncounters[0]!.startedTs).toBeGreaterThan(view.recentEncounters[1]!.startedTs);

    // The NAMED enemy is never the top actor — the owner is.
    const boss = view.recentEncounters.find((e) => e.name === "Venril Sathir")!;
    expect(boss.topActorName).toBe("Playerone");
    // updatedTs is the log clock (last event ts), not wall-clock.
    expect(view.updatedTs).toBeGreaterThan(0);
  });

  it("is deterministic: two independent loads produce byte-identical views", () => {
    const p = writeLog(TWO_ENCOUNTERS);
    const a = new SessionService({ db: freshDb(), logFile: logFile(p), live: false }).start();
    const b = new SessionService({ db: freshDb(), logFile: logFile(p), live: false }).start();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ── 2. Attribution honesty through the seam (active encounter) ────────────────

describe("attribution through the seam", () => {
  it("folds the pet into its owner and never lists the enemy as an actor", () => {
    const db = freshDb();
    const svc = new SessionService({ db, logFile: logFile(writeLog(OPEN_BOSS)), live: true, tailer: { pollIntervalMs: 20 } });
    const view = svc.start();
    svc.stop(); // no growth needed; the replayed encounter is already active

    expect(view.currentEncounter).not.toBeNull();
    const actors = view.currentEncounter!.actors;
    const names = actors.map((a) => a.entityName);
    expect(names).toContain("Playerone");
    expect(names).not.toContain("Pettwo"); // folded into the owner
    expect(names).not.toContain("Venril Sathir"); // enemy is never an actor
    // Owner-folded rows: the owner tops the ranking (dps desc).
    expect(actors[0]!.entityName).toBe("Playerone");
    for (let i = 1; i < actors.length; i++) expect(actors[i - 1]!.dps).toBeGreaterThanOrEqual(actors[i]!.dps);
    // Provenance surfaced so the UI never renders a guess as fact.
    expect(view.currentEncounter!.provenance.minConfidence).toBeGreaterThan(0);
  });

  it("picks the most-recently-active encounter when several are active at once", () => {
    // Both the beetle (older) and Venril (later activity) are active. The tracker's
    // "current" fight must be Venril — the latest activity — not the oldest-started
    // beetle that listEncounters returns first. (Regression guard for the
    // oldest-first `find(active)` bug.)
    const db = freshDb();
    const svc = new SessionService({ db, logFile: logFile(writeLog(TWO_ACTIVE)), live: true, tailer: { pollIntervalMs: 20 } });
    const view = svc.start();
    svc.stop();
    expect(view.currentEncounter).not.toBeNull();
    expect(view.currentEncounter!.header.name).toBe("Venril Sathir");
  });

  it("live leaves the last encounter active; static closes it", () => {
    const p = writeLog(OPEN_BOSS);
    const liveSvc = new SessionService({ db: freshDb(), logFile: logFile(p), live: true, tailer: { pollIntervalMs: 20 } });
    const liveView = liveSvc.start();
    expect(liveView.status).toBe("live");
    expect(liveView.currentEncounter).not.toBeNull();
    liveSvc.stop();

    const staticView = new SessionService({ db: freshDb(), logFile: logFile(p), live: false }).start();
    expect(staticView.currentEncounter).toBeNull();
  });
});

// ── 3. Live heartbeat ────────────────────────────────────────────────────────

describe("live heartbeat", () => {
  it("refresh() advances on new bytes, moves the fight active→closed, and is idempotent otherwise", async () => {
    const logPath = writeLog(OPEN_BOSS);
    const db = freshDb();
    const svc = new SessionService({ db, logFile: logFile(logPath), live: true, tailer: { pollIntervalMs: 20 } });

    const updates: number[] = [];
    svc.onUpdate((v) => updates.push(v.watermark.seq));

    const first = svc.start();
    const startSeq = first.watermark.seq;
    // The replayed boss fight is active; nothing closed yet.
    expect(first.currentEncounter?.header.name).toBe("Venril Sathir");
    expect(first.recentEncounters.length).toBe(0);

    // Idempotent: no new bytes → equal view, no onUpdate.
    const again = svc.refresh();
    expect(again.watermark.seq).toBe(startSeq);
    expect(updates.length).toBe(0);

    // Grow the file: kill + XP, then a later zone-enter > 15 s past the fight so the
    // encounter times out and closes. The tailer ingests asynchronously — poll
    // refresh() until the watermark advances.
    appendLines(logPath, [
      "[Fri Jul 10 17:20:22 2026] You have slain Venril Sathir!",
      "[Fri Jul 10 17:20:22 2026] You gain experience! (4.000%)",
      "[Fri Jul 10 17:20:45 2026] You have entered The Northern Desert of Ro.",
    ]);

    let latest = first;
    let advanced = false;
    for (let i = 0; i < 100 && !advanced; i++) {
      await sleep(20);
      latest = svc.refresh();
      if (latest.watermark.seq > startSeq) advanced = true;
    }
    svc.stop();

    expect(advanced).toBe(true);
    expect(updates.length).toBeGreaterThanOrEqual(1);
    for (const seq of updates) expect(seq).toBeGreaterThan(startSeq);
    // The fight moved from currentEncounter (active) to recentEncounters (closed).
    expect(latest.currentEncounter).toBeNull();
    expect(latest.recentEncounters.map((e) => e.name)).toContain("Venril Sathir");
  });
});

// ── 4. Thin-seam & determinism guards ────────────────────────────────────────

describe("seam discipline", () => {
  it("exposes only the service class as a runtime value — no db/parser internals leak", () => {
    // Types are erased at runtime; the only runtime export must be SessionService.
    const runtimeExports = Object.keys(serviceModule).filter(
      (k) => (serviceModule as Record<string, unknown>)[k] !== undefined,
    );
    expect(runtimeExports).toEqual(["SessionService"]);
  });

  it("contains no wall-clock or randomness in src (determinism gate)", () => {
    const srcDir = path.join(import.meta.dirname, "..", "src");
    for (const f of fs.readdirSync(srcDir)) {
      if (!f.endsWith(".ts")) continue;
      // Strip block + line comments so the gate tests real code, not the prose
      // that explains the invariant (which legitimately names these APIs).
      const code = fs
        .readFileSync(path.join(srcDir, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/Date\.now|Math\.random|new Date\(/);
    }
  });
});
