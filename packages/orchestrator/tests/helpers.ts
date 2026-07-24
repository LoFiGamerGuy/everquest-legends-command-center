/**
 * Synthetic in-repo fixtures for orchestrator tests.
 *
 * These are NOT real player logs (none are available and none may be committed —
 * CLAUDE.md). Every line below reuses a line SHAPE already verified by a
 * committed fixture in tests/fixtures/eql-beta-2026-07/ (zone-enter, pet-chatter,
 * melee-hit, kill-death, raw-unknown), with the anonymized names the fixtures
 * use. We only assemble known-good shapes into a multi-line file; we never
 * fabricate a new format.
 */

import { openDatabase, migrate, type LogFileInput, type SqlDatabase } from "@eqlcc/database";
import { DIALECT_EQL_BETA_2026_07 } from "@eqlcc/event-schema";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The tracked file name — drives EntityResolver owner = "Playerone". */
export const LOG_FILE_NAME = "eqlog_Playerone_erudin.txt";

/**
 * The synthetic log, one message per line. Lines 1–4 are the "before crash"
 * prefix; the cut falls after line 4. Line 2 (pet_chatter) establishes the
 * Petone->Playerone link BEFORE the cut; lines 5 and 8 are Petone melee hits
 * AFTER the cut, so a surviving link proves the resolver snapshot was RESTORED
 * (those establishing bytes are never re-read on resume).
 */
export const LOG_LINES: readonly string[] = [
  "[Fri Jul 10 17:14:06 2026] You have entered The Northern Desert of Ro.",
  "[Fri Jul 10 17:20:12 2026] Petone told you, 'Attacking a large rattlesnake Master.'",
  "[Fri Jul 10 17:20:14 2026] You slash a large rattlesnake for 12 points of damage.",
  "[Tue Jul 21 17:21:38 2026] A fire beetle chitters and buzzes its translucent wings in anticipation of battle.",
  "[Fri Jul 10 17:20:18 2026] Petone slashes a large rattlesnake for 8 points of damage.",
  "[Sat Jul 11 00:15:07 2026] You slash a large rattlesnake for 10 points of damage. (Critical)",
  "[Fri Jul 10 17:20:22 2026] You have slain a large rattlesnake!",
  "[Fri Jul 10 17:20:29 2026] Petone slashes a fire beetle for 6 points of damage.",
  "[Fri Jul 10 17:20:31 2026] You kick a fire beetle for 3 points of damage.",
  "[Fri Jul 10 17:25:57 2026] A fire beetle has been slain by Playerten!",
];

/** Expected event type per line, in order (asserted by the replay test). */
export const EXPECTED_TYPES: readonly string[] = [
  "zone_enter",
  "pet_chatter",
  "melee_hit",
  "raw_unknown",
  "melee_hit",
  "melee_hit",
  "kill",
  "melee_hit",
  "melee_hit",
  "kill",
];

/** Number of lines before the simulated crash (cut is after this many lines). */
export const CUT_AFTER_LINE = 4;

/** Full file text (every line terminated by `\n`, incl. the last). */
export function fullText(): string {
  return LOG_LINES.map((l) => `${l}\n`).join("");
}

/** Byte offset at the START of 1-based line `n` (== resume offset after line n-1). */
export function offsetOfLine(n: number): number {
  let offset = 0;
  for (let i = 0; i < n - 1; i++) offset += (LOG_LINES[i] as string).length + 1; // +1 for '\n'
  return offset;
}

/** The cut byte offset: start of the first line after the crash prefix. */
export function cutOffset(): number {
  return offsetOfLine(CUT_AFTER_LINE + 1);
}

/** Total byte length of the full file. */
export function fullSize(): number {
  return Buffer.byteLength(fullText(), "latin1");
}

/** Create a temp dir with the log file written, returning its absolute path + a cleanup fn. */
export function writeTempLog(content: string): {
  dir: string;
  logPath: string;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eqlcc-orch-"));
  const logPath = path.join(dir, LOG_FILE_NAME);
  fs.writeFileSync(logPath, Buffer.from(content, "latin1"));
  return { dir, logPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** A migrated in-memory database (base schema only; the pipeline adds resolver_snapshot). */
export function freshDb(): SqlDatabase {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

/** LogFileInput for the synthetic file at `logPath`. */
export function logFileInput(logPath: string): LogFileInput {
  return {
    path: logPath,
    characterName: "Playerone",
    server: "erudin",
    dialectId: DIALECT_EQL_BETA_2026_07,
  };
}

/** A stored-event row projected to the fields that must be byte-identical across runs. */
export interface StoredEvent {
  seq: number;
  byteOffset: number;
  raw: string;
  ts: number;
  type: string;
  dialectId: string;
  ruleId: string | null;
  payload: string;
}

/** Read all events for a log file, in canonical (seq) order, as comparable rows. */
export function allEvents(db: SqlDatabase, logFileId: number): StoredEvent[] {
  return db
    .prepare(
      `SELECT seq, byte_offset AS byteOffset, raw, ts, type,
              dialect_id AS dialectId, rule_id AS ruleId, payload
       FROM events WHERE log_file_id = ? ORDER BY seq`,
    )
    .all(logFileId) as StoredEvent[];
}

/** Count events for a log file. */
export function eventCount(db: SqlDatabase, logFileId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE log_file_id = ?")
    .get(logFileId) as { n: number };
  return row.n;
}

/** Poll `predicate` until true or timeout (for the async live tailer). */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
  stepMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`waitFor: predicate not satisfied within ${timeoutMs}ms`);
}
