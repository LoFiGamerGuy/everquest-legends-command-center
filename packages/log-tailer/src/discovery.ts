/**
 * Log-file discovery (ARCHITECTURE.md §4/§5.5).
 *
 * Scans a configured Logs directory for game-written log files named
 * `eqlog_<Character>_<server>.txt` and returns their metadata, most recently
 * modified first. Unrelated files, subdirectories, and files that vanish
 * between listing and stat are silently tolerated — discovery never throws
 * because of a non-log entry.
 *
 * This module only *reads* directory metadata; it opens nothing.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Metadata for one discovered `eqlog_<Character>_<server>.txt` file. */
export interface DiscoveredLogFile {
  /** Absolute path to the log file. Stable across rescans; used as the file id. */
  path: string;
  /** Base file name, e.g. `eqlog_Playerone_erudin.txt`. */
  fileName: string;
  /** Character name parsed from the file name (verbatim casing). */
  character: string;
  /** Server name parsed from the file name (verbatim casing). */
  server: string;
  /** File size in bytes at scan time. */
  sizeBytes: number;
  /** Modification time in epoch milliseconds at scan time. */
  mtimeMs: number;
}

/**
 * `eqlog_<Character>_<server>.txt`, case-insensitive on the `eqlog_` prefix
 * and `.txt` suffix.
 *
 * EQ character names never contain underscores, so the character is
 * everything up to the first `_` after the prefix and the server is the rest
 * (servers may themselves contain underscores or dots in test environments).
 * Both parts must be non-empty.
 */
const LOG_FILE_NAME = /^eqlog_([^_]+)_(.+)\.txt$/i;

/**
 * Parse `eqlog_<Character>_<server>.txt` into its parts.
 * Returns `null` for anything that does not match (unrelated file).
 */
export function parseLogFileName(fileName: string): { character: string; server: string } | null {
  const m = LOG_FILE_NAME.exec(fileName);
  if (m === null) return null;
  const character = m[1];
  const server = m[2];
  if (character === undefined || server === undefined) return null;
  return { character, server };
}

/**
 * Scan `logsDir` (non-recursively) for `eqlog_<Character>_<server>.txt` files.
 *
 * @returns Discovered files ordered most-recently-modified first (ties broken
 *   by path for determinism).
 * @throws If `logsDir` itself cannot be read (missing/denied) — a
 *   misconfigured directory is a caller error, not something to hide. Bad
 *   *entries* inside the directory never throw.
 */
export function discoverLogFiles(logsDir: string): DiscoveredLogFile[] {
  const dir = path.resolve(logsDir);
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const found: DiscoveredLogFile[] = [];
  for (const entry of entries) {
    // Tolerate directories/sockets/etc. that happen to match the name.
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const parsed = parseLogFileName(entry.name);
    if (parsed === null) continue;
    const filePath = path.join(dir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath); // follows symlinks
    } catch {
      continue; // vanished or unreadable between readdir and stat — skip
    }
    if (!stat.isFile()) continue;
    found.push({
      path: filePath,
      fileName: entry.name,
      character: parsed.character,
      server: parsed.server,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return found;
}
