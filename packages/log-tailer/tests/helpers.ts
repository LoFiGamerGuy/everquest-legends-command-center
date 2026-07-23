/**
 * Shared test utilities. All test files live in fresh directories under the
 * OS tmpdir (never the repo tree) and are removed after each test.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { LineBatch, LogTailer, TailedLine, TruncationEvent } from "../src/index.js";

/** Create a fresh temp dir under the OS tmpdir; caller cleans up via rmDirs. */
export function makeTmpDir(created: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eqlcc-log-tailer-"));
  created.push(dir);
  return dir;
}

export function rmDirs(dirs: string[]): void {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Poll until `cond()` is truthy or the timeout elapses (then throw). */
export async function waitFor(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Recorder for one tailer's output. */
export interface Recorder {
  batches: LineBatch[];
  truncations: TruncationEvent[];
  lines(): TailedLine[];
  texts(): string[];
}

export function record(tailer: LogTailer): Recorder {
  const batches: LineBatch[] = [];
  const truncations: TruncationEvent[] = [];
  tailer.on("lines", (b) => batches.push(b));
  tailer.on("truncated", (t) => truncations.push(t));
  return {
    batches,
    truncations,
    lines: () => batches.flatMap((b) => b.lines),
    texts: () => batches.flatMap((b) => b.lines.map((l) => l.line)),
  };
}

/** Append raw content to a file (creating it if needed). */
export function append(filePath: string, content: string | Buffer): void {
  fs.appendFileSync(filePath, content);
}
