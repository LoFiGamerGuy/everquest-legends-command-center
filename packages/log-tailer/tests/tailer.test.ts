import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LogTailer, type TailedLine } from "../src/index.js";
import { append, makeTmpDir, record, rmDirs, sleep, waitFor } from "./helpers.js";

const POLL = 20; // fast polling for tests; production default is 200 ms

const dirs: string[] = [];
const tailers: LogTailer[] = [];
afterEach(() => {
  for (const t of tailers.splice(0)) t.stop();
  rmDirs(dirs);
});

function makeTailer(filePath: string, options: ConstructorParameters<typeof LogTailer>[1] = {}): LogTailer {
  const tailer = new LogTailer(filePath, { pollIntervalMs: POLL, ...options });
  tailers.push(tailer);
  return tailer;
}

function logPath(dir: string): string {
  return path.join(dir, "eqlog_Playerone_erudin.txt");
}

describe("LogTailer — append detection", () => {
  it("emits complete lines across multiple separate flushes, with exact offsets", async () => {
    const dir = makeTmpDir(dirs);
    const file = logPath(dir);
    fs.writeFileSync(file, "");

    const tailer = makeTailer(file);
    const rec = record(tailer);
    tailer.start(0);

    append(file, "first line\n");
    await waitFor(() => rec.lines().length >= 1, "first flush");

    append(file, "second\nthird\n");
    await waitFor(() => rec.lines().length >= 3, "second flush");

    expect(rec.lines()).toEqual([
      { line: "first line", byteOffset: 0, lineNo: 1 },
      { line: "second", byteOffset: 11, lineNo: 2 },
      { line: "third", byteOffset: 18, lineNo: 3 },
    ] satisfies TailedLine[]);
    // Watermark of the last batch = offset past the final terminator.
    expect(rec.batches.at(-1)!.watermark).toBe(24);
    expect(tailer.watermark).toBe(24);
  });

  it("keeps working when the file does not exist yet (transient ENOENT swallowed)", async () => {
    const dir = makeTmpDir(dirs);
    const file = logPath(dir);

    const tailer = makeTailer(file);
    const rec = record(tailer);
    tailer.start(0);

    await sleep(POLL * 3); // several polls against a missing file: no crash, no events
    expect(rec.lines()).toEqual([]);

    fs.writeFileSync(file, "born late\n");
    await waitFor(() => rec.lines().length >= 1, "line after file creation");
    expect(rec.texts()).toEqual(["born late"]);
  });
});

describe("LogTailer — partial-line buffering", () => {
  it("buffers a trailing partial line across writes and never advances the watermark past it", async () => {
    const dir = makeTmpDir(dirs);
    const file = logPath(dir);
    fs.writeFileSync(file, "");

    const tailer = makeTailer(file);
    const rec = record(tailer);
    tailer.start(0);

    append(file, "incomplete");
    await sleep(POLL * 4); // several polls: bytes read, but no terminator yet
    expect(rec.lines()).toEqual([]);
    expect(tailer.watermark).toBe(0);

    append(file, " but finished\nnext-partial");
    await waitFor(() => rec.lines().length >= 1, "completed first line");
    expect(rec.texts()).toEqual(["incomplete but finished"]);
    const done = Buffer.byteLength("incomplete but finished\n");
    expect(tailer.watermark).toBe(done); // "next-partial" still buffered

    append(file, "\n");
    await waitFor(() => rec.lines().length >= 2, "completed second line");
    expect(rec.lines()[1]).toEqual({ line: "next-partial", byteOffset: done, lineNo: 2 });
  });
});

describe("LogTailer — CRLF and LF", () => {
  it("handles mixed terminators, including a CRLF split across two writes", async () => {
    const dir = makeTmpDir(dirs);
    const file = logPath(dir);
    fs.writeFileSync(file, "");

    const tailer = makeTailer(file);
    const rec = record(tailer);
    tailer.start(0);

    append(file, "one\r\ntwo\n");
    await waitFor(() => rec.lines().length >= 2, "first two lines");

    append(file, "three\r"); // CR written first ...
    await sleep(POLL * 3);
    expect(rec.lines()).toHaveLength(2); // ... must NOT emit yet

    append(file, "\nfour\n"); // ... LF completes the CRLF in a later write
    await waitFor(() => rec.lines().length >= 4, "remaining lines");

    expect(rec.lines()).toEqual([
      { line: "one", byteOffset: 0, lineNo: 1 },
      { line: "two", byteOffset: 5, lineNo: 2 },
      { line: "three", byteOffset: 9, lineNo: 3 },
      { line: "four", byteOffset: 16, lineNo: 4 },
    ] satisfies TailedLine[]);
    expect(tailer.watermark).toBe(21);
  });

  it("decodes Windows-1252 bytes while offsets keep counting raw bytes", async () => {
    const dir = makeTmpDir(dirs);
    const file = logPath(dir);
    // 0x92 = Windows-1252 right single quote; invalid as UTF-8.
    fs.writeFileSync(file, Buffer.from([0x59, 0x6f, 0x75, 0x92, 0x76, 0x65, 0x0a, 0x6f, 0x6b, 0x0a]));

    const tailer = makeTailer(file);
    const rec = record(tailer);
    tailer.start(0);
    await waitFor(() => rec.lines().length >= 2, "decoded lines");

    expect(rec.lines()).toEqual([
      { line: "You’ve", byteOffset: 0, lineNo: 1 },
      { line: "ok", byteOffset: 7, lineNo: 2 }, // offset counts the raw 0x92 byte, not code units
    ] satisfies TailedLine[]);
  });
});

describe("LogTailer — truncation / rotation", () => {
  it("emits 'truncated' and restarts from offset 0 when the file shrinks below the watermark", async () => {
    const dir = makeTmpDir(dirs);
    const file = logPath(dir);
    fs.writeFileSync(file, "old-1\nold-2\n");

    const tailer = makeTailer(file);
    const rec = record(tailer);
    tailer.start(0);
    await waitFor(() => rec.lines().length >= 2, "initial lines");
    expect(tailer.watermark).toBe(12);

    fs.truncateSync(file, 0); // player deleted the log; game recreates it
    await waitFor(() => rec.truncations.length >= 1, "truncation event");
    expect(rec.truncations[0]).toMatchObject({ previousWatermark: 12, newLength: 0 });
    expect(tailer.watermark).toBe(0);

    append(file, "new-1\n");
    await waitFor(() => rec.lines().length >= 3, "line after truncation");
    // Restarted from 0: fresh offsets and line numbers.
    expect(rec.lines()[2]).toEqual({ line: "new-1", byteOffset: 0, lineNo: 1 });
  });
});

describe("LogTailer — resume from stored offset", () => {
  it("re-tailing from every recorded line offset reproduces the exact suffix (no gaps, no duplicates)", async () => {
    const dir = makeTmpDir(dirs);
    const file = logPath(dir);
    // Mixed LF/CRLF plus a Windows-1252 byte to prove offsets are byte-true.
    const raw = Buffer.concat([
      Buffer.from("[Wed Jul 22 21:03:11 2026] You gain experience!\r\n"),
      Buffer.from([0x61, 0x92, 0x62, 0x0a]), // "a’b\n" in cp1252
      Buffer.from("[Wed Jul 22 21:03:12 2026] A rat bites YOU for 3 points of damage.\n"),
      Buffer.from("short\r\n"),
      Buffer.from("[Wed Jul 22 21:03:13 2026] You have slain a rat!\n"),
    ]);
    fs.writeFileSync(file, raw);

    // Pass 1: full read from 0, recording per-line offsets and the final watermark.
    const first = makeTailer(file);
    const rec1 = record(first);
    first.start(0);
    await waitFor(() => rec1.lines().length >= 5, "full first pass");
    first.stop();
    const reference = rec1.lines();
    expect(reference).toHaveLength(5);
    expect(rec1.batches.at(-1)!.watermark).toBe(raw.length);

    // Pass 2: resume from each line's start offset; must reproduce exactly
    // the suffix from that line on — same text, same offsets.
    for (let i = 0; i < reference.length; i++) {
      const fromOffset = reference[i]!.byteOffset;
      const again = makeTailer(file);
      const recN = record(again);
      again.start(fromOffset);
      await waitFor(
        () => recN.lines().length >= reference.length - i,
        `resume pass from offset ${fromOffset}`,
      );
      again.stop();
      expect(recN.lines().map(({ line, byteOffset }) => ({ line, byteOffset }))).toEqual(
        reference.slice(i).map(({ line, byteOffset }) => ({ line, byteOffset })),
      );
    }

    // Resuming from the end-of-file watermark yields nothing (no duplicates).
    const atEnd = makeTailer(file);
    const recEnd = record(atEnd);
    atEnd.start(raw.length);
    await sleep(POLL * 3);
    atEnd.stop();
    expect(recEnd.lines()).toEqual([]);
  });

  it("a stored batch watermark restarts exactly where the previous session left off", async () => {
    const dir = makeTmpDir(dirs);
    const file = logPath(dir);
    fs.writeFileSync(file, "a\nb\nc\n");

    const session1 = makeTailer(file);
    const rec1 = record(session1);
    session1.start(0);
    await waitFor(() => rec1.lines().length >= 3, "session 1");
    const stored = rec1.batches.at(-1)!.watermark; // "persisted by the DB layer"
    session1.stop();

    append(file, "d\ne\n"); // written while "the app was closed"

    const session2 = makeTailer(file);
    const rec2 = record(session2);
    session2.start(stored);
    await waitFor(() => rec2.lines().length >= 2, "session 2");
    expect(rec2.lines().map(({ line, byteOffset }) => ({ line, byteOffset }))).toEqual([
      { line: "d", byteOffset: 6 },
      { line: "e", byteOffset: 8 },
    ]);
  });
});

describe("LogTailer — rapid appends", () => {
  it("captures every line exactly once, in order, under appends faster than the poll interval", async () => {
    const dir = makeTmpDir(dirs);
    const file = logPath(dir);
    fs.writeFileSync(file, "");

    const tailer = makeTailer(file);
    const rec = record(tailer);
    tailer.start(0);

    const total = 500;
    for (let i = 0; i < total; i++) {
      append(file, `line-${i}\n`);
      if (i % 50 === 49) await sleep(1); // bursts of 50 between microscopic gaps
    }
    await waitFor(() => rec.lines().length >= total, "all rapid lines", 10_000);

    const got = rec.lines();
    expect(got).toHaveLength(total); // exactly once — no duplicates
    expect(got.map((l) => l.line)).toEqual(Array.from({ length: total }, (_, i) => `line-${i}`));
    // Offsets are contiguous: each line starts where the previous ended.
    let expected = 0;
    for (const l of got) {
      expect(l.byteOffset).toBe(expected);
      expected += Buffer.byteLength(`${l.line}\n`);
    }
    expect(tailer.watermark).toBe(expected);
  });
});

describe("LogTailer — oversized unterminated lines (maxLineBytes)", () => {
  it("flushes a runaway partial as an overflow line and advances the watermark", async () => {
    const dir = makeTmpDir(dirs);
    const file = logPath(dir);
    const runaway = "x".repeat(100); // 100 bytes, no terminator
    fs.writeFileSync(file, runaway);

    const tailer = makeTailer(file, { maxLineBytes: 32 });
    const rec = record(tailer);
    tailer.start(0);

    await waitFor(() => rec.lines().length >= 1, "overflow flush");
    expect(rec.lines()[0]).toEqual({
      line: runaway,
      byteOffset: 0,
      lineNo: 1,
      overflow: true,
    });
    expect(tailer.watermark).toBe(100); // advanced past the flushed bytes

    // Bytes after the flush start a fresh line at a byte-true offset.
    append(file, "tail\n");
    await waitFor(() => rec.lines().length >= 2, "line after overflow");
    expect(rec.lines()[1]).toEqual({ line: "tail", byteOffset: 100, lineNo: 2 });
  });

  it("never lets the buffered partial exceed maxLineBytes + maxChunkBytes under steady growth", async () => {
    const dir = makeTmpDir(dirs);
    const file = logPath(dir);
    fs.writeFileSync(file, "");

    const tailer = makeTailer(file, { maxLineBytes: 64, maxChunkBytes: 32 });
    const rec = record(tailer);
    tailer.start(0);

    const total = 400; // one long line, written in unterminated dribbles
    for (let i = 0; i < 20; i++) {
      append(file, "y".repeat(20));
      await sleep(POLL);
    }
    append(file, "\n"); // finally terminate, so any sub-threshold leftover emits too
    await waitFor(() => tailer.watermark >= total + 1, "all runaway bytes emitted");

    const got = rec.lines();
    expect(got.length).toBeGreaterThan(1); // the cap forced at least one mid-line flush
    // Every emission except the final terminated remainder is an overflow flush.
    expect(got.slice(0, -1).every((l) => l.overflow === true)).toBe(true);
    // No emission ever exceeds the documented bound (the buffer never grew past it).
    expect(Math.max(...got.map((l) => l.line.length))).toBeLessThanOrEqual(64 + 32);
    // Emissions are contiguous and lossless: concatenation is the original bytes.
    let offset = 0;
    for (const l of got) {
      expect(l.byteOffset).toBe(offset);
      offset += l.line.length;
    }
    expect(got.map((l) => l.line).join("")).toBe("y".repeat(total));
    expect(tailer.watermark).toBe(total + 1); // past the terminator
  });
});

describe("LogTailer — stop()/start() generation guard (regression)", () => {
  it("an in-flight pass abandoned by stop(); start(0) never leaks stale or misaligned offsets", async () => {
    const dir = makeTmpDir(dirs);
    const file = logPath(dir);
    // Fixed-width numbered lines: any offset misalignment breaks the checks.
    const total = 400;
    const content = Array.from({ length: total }, (_, i) => `line-${String(i).padStart(4, "0")}\n`).join("");
    const lineBytes = Buffer.byteLength("line-0000\n");
    fs.writeFileSync(file, content);

    // Tiny chunks force a long multi-await read pass. Restarting via
    // setImmediate from inside a 'lines' handler races the pass's pending
    // read(): without the generation guard, a read issued at an old offset
    // resolves *after* start(0) reset the state, and its bytes are ingested
    // with base offset 0 — exactly the corrupted-offset bug under test.
    const tailer = makeTailer(file, { maxChunkBytes: 64 });
    const rec = record(tailer);

    const restarts = 8;
    let restartsDone = 0;
    let restartPending = false;
    tailer.on("lines", () => {
      if (restartsDone >= restarts || restartPending) return;
      restartsDone++;
      restartPending = true;
      setImmediate(() => {
        tailer.stop(); // mid-activity: the current pass has reads in flight
        rec.batches.length = 0; // everything from here belongs to the fresh run
        tailer.start(0);
        restartPending = false;
      });
    });
    tailer.start(0);

    await waitFor(
      () => restartsDone >= restarts && !restartPending && rec.lines().length >= total,
      "full fresh pass after final restart",
      10_000,
    );
    const got = rec.lines();
    // Exactly the whole file, once: no stale batch, no duplicate, no gap.
    expect(got).toHaveLength(total);
    for (let i = 0; i < total; i++) {
      expect(got[i]).toEqual({
        line: `line-${String(i).padStart(4, "0")}`,
        byteOffset: i * lineBytes,
        lineNo: i + 1,
      });
    }
    expect(tailer.watermark).toBe(total * lineBytes);
  });
});

describe("LogTailer — stop()", () => {
  it("stops cleanly: no events after stop, idempotent, and restartable", async () => {
    const dir = makeTmpDir(dirs);
    const file = logPath(dir);
    fs.writeFileSync(file, "a\n");

    const tailer = makeTailer(file);
    const rec = record(tailer);
    tailer.start(0);
    await waitFor(() => rec.lines().length >= 1, "first line");

    tailer.stop();
    tailer.stop(); // idempotent
    expect(tailer.isRunning).toBe(false);

    append(file, "after-stop\n");
    await sleep(POLL * 5);
    expect(rec.texts()).toEqual(["a"]); // nothing emitted after stop

    // Restart from the watermark we already had: resumes cleanly.
    tailer.start(tailer.watermark);
    await waitFor(() => rec.lines().length >= 2, "line after restart");
    expect(rec.texts()).toEqual(["a", "after-stop"]);
    tailer.stop();
  });

  it("rejects double start and invalid offsets", () => {
    const dir = makeTmpDir(dirs);
    const file = logPath(dir);
    fs.writeFileSync(file, "");
    const tailer = makeTailer(file);
    tailer.start(0);
    expect(() => tailer.start(0)).toThrow(/already running/);
    tailer.stop();
    expect(() => tailer.start(-1)).toThrow(RangeError);
    expect(() => tailer.start(1.5)).toThrow(RangeError);
  });
});
