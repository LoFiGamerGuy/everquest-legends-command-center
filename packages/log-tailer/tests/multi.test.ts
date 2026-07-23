import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TailManager, type ManagedLineBatch, type ManagedTruncationEvent } from "../src/index.js";
import { append, makeTmpDir, rmDirs, sleep, waitFor } from "./helpers.js";

const POLL = 20;

const dirs: string[] = [];
const managers: TailManager[] = [];
afterEach(() => {
  for (const m of managers.splice(0)) m.stop();
  rmDirs(dirs);
});

function makeManager(options: Omit<ConstructorParameters<typeof TailManager>[0], "tailer">): TailManager {
  const manager = new TailManager({ ...options, tailer: { pollIntervalMs: POLL } });
  managers.push(manager);
  return manager;
}

function recordManager(manager: TailManager) {
  const batches: ManagedLineBatch[] = [];
  const truncations: ManagedTruncationEvent[] = [];
  manager.on("lines", (b) => batches.push(b));
  manager.on("truncated", (t) => truncations.push(t));
  return {
    batches,
    truncations,
    linesOf: (fileId: string) =>
      batches.filter((b) => b.fileId === fileId).flatMap((b) => b.lines.map((l) => l.line)),
  };
}

/** Create a log file and backdate its mtime by `ageSec`. */
function makeLog(dir: string, character: string, server: string, ageSec: number): string {
  const p = path.join(dir, `eqlog_${character}_${server}.txt`);
  fs.writeFileSync(p, "");
  const t = Date.now() / 1000 - ageSec;
  fs.utimesSync(p, t, t);
  return p;
}

describe("TailManager", () => {
  it("tails only the N most recently modified files, with the absolute path as a stable fileId", async () => {
    const dir = makeTmpDir(dirs);
    const oldest = makeLog(dir, "Playerone", "erudin", 300);
    const middle = makeLog(dir, "Playertwo", "freeport", 200);
    const newest = makeLog(dir, "Playerthree", "neriak", 100);
    fs.writeFileSync(path.join(dir, "dbg.txt"), "unrelated");

    const manager = makeManager({ logsDir: dir, maxFiles: 2 });
    const rec = recordManager(manager);
    manager.start();

    expect(new Set(manager.files().keys())).toEqual(new Set([newest, middle]));
    expect(manager.files().get(newest)?.character).toBe("Playerthree");

    append(newest, "n1\n");
    append(middle, "m1\n");
    append(oldest, "o1\n"); // NOT tailed — must never surface

    await waitFor(() => rec.batches.length >= 2, "batches from both tailed files");
    await sleep(POLL * 3); // grace period in which the oldest file could wrongly appear
    expect(rec.linesOf(newest)).toEqual(["n1"]);
    expect(rec.linesOf(middle)).toEqual(["m1"]);
    expect(rec.linesOf(oldest)).toEqual([]);
    expect(rec.batches.every((b) => b.file.path === b.fileId)).toBe(true);
  });

  it("starts each file at the offset the caller resolves (stored watermark)", async () => {
    const dir = makeTmpDir(dirs);
    const file = makeLog(dir, "Playerone", "erudin", 0);
    fs.writeFileSync(file, "seen-1\nseen-2\nunseen\n");
    const stored = Buffer.byteLength("seen-1\nseen-2\n");

    const manager = makeManager({
      logsDir: dir,
      resolveStartOffset: (f) => (f.path === file ? stored : 0),
    });
    const rec = recordManager(manager);
    manager.start();

    await waitFor(() => rec.linesOf(file).length >= 1, "resumed line");
    expect(rec.linesOf(file)).toEqual(["unseen"]); // nothing before the watermark re-emitted
    expect(rec.batches[0]!.lines[0]!.byteOffset).toBe(stored);
    expect(manager.watermarkOf(file)).toBe(stored + Buffer.byteLength("unseen\n"));
  });

  it("propagates truncation events tagged with the fileId", async () => {
    const dir = makeTmpDir(dirs);
    const file = makeLog(dir, "Playerone", "erudin", 0);
    fs.writeFileSync(file, "a\nb\n");

    const manager = makeManager({ logsDir: dir });
    const rec = recordManager(manager);
    manager.start();
    await waitFor(() => rec.linesOf(file).length >= 2, "initial lines");

    fs.truncateSync(file, 0);
    await waitFor(() => rec.truncations.length >= 1, "manager truncation event");
    expect(rec.truncations[0]).toMatchObject({ fileId: file, previousWatermark: 4, newLength: 0 });
  });

  it("rescan() picks up files that appear later, without disturbing live tails", async () => {
    const dir = makeTmpDir(dirs);
    const first = makeLog(dir, "Playerone", "erudin", 100);

    const manager = makeManager({ logsDir: dir });
    const rec = recordManager(manager);
    manager.start();
    expect([...manager.files().keys()]).toEqual([first]);

    const second = makeLog(dir, "Playertwo", "freeport", 0);
    const { added, removed } = manager.rescan();
    expect(added.map((f) => f.path)).toEqual([second]);
    expect(removed).toEqual([]);
    expect(new Set(manager.files().keys())).toEqual(new Set([first, second]));

    append(second, "hello\n");
    await waitFor(() => rec.linesOf(second).length >= 1, "line from rescanned file");
    expect(rec.linesOf(second)).toEqual(["hello"]);
  });

  it("rescan() at maxFiles capacity swaps a newer file in, stopping the dropped tailer cleanly", async () => {
    const dir = makeTmpDir(dirs);
    const older = makeLog(dir, "Playerone", "erudin", 100);

    const manager = makeManager({ logsDir: dir, maxFiles: 1 });
    const rec = recordManager(manager);
    manager.start();
    append(older, "o1\n");
    await waitFor(() => rec.linesOf(older).length >= 1, "line before swap");
    // The append above refreshed older's mtime; backdate it again so the
    // ranking under test is unambiguous.
    const back = Date.now() / 1000 - 100;
    fs.utimesSync(older, back, back);

    const newer = makeLog(dir, "Playertwo", "freeport", 0); // strictly newer mtime
    const { added, removed } = manager.rescan();
    expect(added.map((f) => f.path)).toEqual([newer]);
    expect(removed.map((f) => f.path)).toEqual([older]);
    expect([...manager.files().keys()]).toEqual([newer]);
    expect(manager.watermarkOf(older)).toBeUndefined();

    append(newer, "n1\n");
    append(older, "o2\n"); // dropped tailer must be fully stopped: never surfaces
    await waitFor(() => rec.linesOf(newer).length >= 1, "line from swapped-in file");
    await sleep(POLL * 5);
    expect(rec.linesOf(newer)).toEqual(["n1"]);
    expect(rec.linesOf(older)).toEqual(["o1"]);
  });

  it("start() is transactional: a bad Logs directory leaves the manager not-running", () => {
    const dir = makeTmpDir(dirs);
    const manager = makeManager({ logsDir: path.join(dir, "does-not-exist") });
    expect(() => manager.start()).toThrow();
    expect(manager.isRunning).toBe(false);
    expect(manager.files().size).toBe(0);
    // Not left half-started: once the directory exists, start() works.
    fs.mkdirSync(path.join(dir, "does-not-exist"));
    manager.start();
    expect(manager.isRunning).toBe(true);
  });

  it("start() is transactional: a throwing resolveStartOffset stops already-started tailers", async () => {
    const dir = makeTmpDir(dirs);
    const good = makeLog(dir, "Playerone", "erudin", 100); // ranked second (older)
    makeLog(dir, "Playertwo", "freeport", 0); // ranked first — resolves fine
    const poison = makeLog(dir, "Playerthree", "neriak", 200); // ranked last — throws

    const manager = makeManager({
      logsDir: dir,
      resolveStartOffset: (f) => {
        if (f.path === poison) throw new Error("watermark lookup failed");
        return 0;
      },
    });
    const rec = recordManager(manager);
    expect(() => manager.start()).toThrow(/watermark lookup failed/);
    expect(manager.isRunning).toBe(false);
    expect(manager.files().size).toBe(0);

    // No stray tailer survived the rollback: appends surface nothing.
    append(good, "leak?\n");
    await sleep(POLL * 5);
    expect(rec.batches).toEqual([]);
  });

  it("validates maxFiles: rejects NaN/zero/negative/fractional, allows Infinity", () => {
    const dir = makeTmpDir(dirs);
    makeLog(dir, "Playerone", "erudin", 0);
    for (const bad of [Number.NaN, 0, -1, 1.5]) {
      expect(() => makeManager({ logsDir: dir, maxFiles: bad })).toThrow(RangeError);
    }
    const all = makeManager({ logsDir: dir, maxFiles: Infinity }); // documented: tail everything
    all.start();
    expect(all.files().size).toBe(1);
  });

  it("forwards consumer failures as 'consumer-error' with the fileId, and the batch replays", async () => {
    const dir = makeTmpDir(dirs);
    const file = makeLog(dir, "Playerone", "erudin", 0);
    fs.writeFileSync(file, "x\n");

    const manager = makeManager({ logsDir: dir });
    const consumerErrors: { fileId: string; lines: string[] | null }[] = [];
    manager.on("consumer-error", (_err, fileId, batch) =>
      consumerErrors.push({ fileId, lines: batch === null ? null : batch.lines.map((l) => l.line) }),
    );
    const accepted: string[] = [];
    let deliveries = 0;
    manager.on("lines", (batch) => {
      deliveries++;
      if (deliveries === 1) throw new Error("manager consumer failed");
      accepted.push(...batch.lines.map((l) => l.line));
    });
    manager.start();

    await waitFor(() => accepted.length >= 1, "replay after manager-level consumer failure");
    expect(consumerErrors).toEqual([{ fileId: file, lines: ["x"] }]);
    expect(accepted).toEqual(["x"]); // exactly once: rejected delivery not double-counted
    expect(manager.watermarkOf(file)).toBe(2);
  });

  it("stop() halts every tailer: appends afterwards emit nothing", async () => {
    const dir = makeTmpDir(dirs);
    const a = makeLog(dir, "Playerone", "erudin", 0);
    const b = makeLog(dir, "Playertwo", "freeport", 0);

    const manager = makeManager({ logsDir: dir });
    const rec = recordManager(manager);
    manager.start();
    append(a, "a1\n");
    await waitFor(() => rec.linesOf(a).length >= 1, "pre-stop line");

    manager.stop();
    manager.stop(); // idempotent
    expect(manager.isRunning).toBe(false);
    expect(manager.files().size).toBe(0);

    append(a, "a2\n");
    append(b, "b1\n");
    await sleep(POLL * 5);
    expect(rec.batches.flatMap((x) => x.lines.map((l) => l.line))).toEqual(["a1"]);
  });
});
