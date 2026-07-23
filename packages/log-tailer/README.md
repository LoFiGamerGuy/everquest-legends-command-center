# @eqlcc/log-tailer

Log discovery and resumable byte-offset tailing for EQL Command Center
(ARCHITECTURE.md §5 "Tailing design"). Pure TypeScript over Node builtins
(`node:fs`, `node:path`, `node:events`) — no Tauri, no DOM, no SQLite — so the
same implementation serves the Node CLI, tests, and (via the desktop shell) the
app.

Strictly **passive**: files are opened read-only, nothing in the game
directory is ever written.

## What it does

- **`discoverLogFiles(logsDir)`** — scan a Logs directory for
  `eqlog_<Character>_<server>.txt`, parse character/server from the name, and
  return `{ path, fileName, character, server, sizeBytes, mtimeMs }` ordered
  most-recently-modified first. Unrelated files are ignored.
- **`LogTailer`** — tail one file by byte offset:
  - `start(fromOffset)` resumes exactly where a stored watermark left off;
    `stop()` releases every timer/watcher.
  - Emits `lines` batches of `{ line, byteOffset, lineNo }` for **complete
    lines only** (`\n`-terminated; `\r\n` tolerated). A trailing partial line
    stays buffered until its newline arrives.
  - Each batch carries a `watermark`: the offset just past the last complete
    line — the only value that is safe to persist.
  - **Truncation/rotation:** observed length < read position ⇒ emit
    `truncated` and restart from offset 0 (players delete logs; the game
    recreates them).
  - **Hybrid scheduling:** a poll loop (default 200 ms) is the source of
    truth; `fs.watch` is subscribed only as a fast-path trigger, because OS
    file events alone are unreliable for game logs. Reads are offset-driven,
    so duplicate wake-ups are harmless.
  - Transient read errors (`EBUSY`, mid-rotation `ENOENT`, ...) are swallowed
    and retried next tick.
  - Bytes are decoded as Windows-1252 (lossless fallback) after slicing;
    offsets always count raw bytes.
- **`TailManager`** — discovery + one `LogTailer` per selected file (the N
  most recently modified, or all), re-emitting events tagged with a stable
  `fileId` (the resolved absolute path — the same identity `log_files.path`
  uses).

## The offset boundary (who persists what)

**This package never persists offsets.** That is deliberate, not an omission:

- The tailer *accepts* a start offset (`start(fromOffset)` /
  `resolveStartOffset`) and *reports* byte offsets (`byteOffset` per line,
  `watermark` per batch). It holds no state that survives a restart.
- Persisting the watermark is the **database layer's** job:
  `log_files.byte_offset` is committed **in the same SQLite transaction** as
  the events parsed from those bytes (DATA_MODEL.md, ARCHITECTURE.md §5.4).
  That atomicity is only possible where the transaction lives — which is why
  it cannot live here.
- Crash-safety follows: either the events and the advanced offset are both
  stored, or neither is. Re-ingesting a batch is harmless anyway — parsing is
  deterministic and `events (log_file_id, byte_offset)` is a uniqueness key.

Resume protocol: read `log_files.byte_offset`, pass it to `start(fromOffset)`,
and after each `lines` batch persist `batch.watermark` atomically with the
batch's parsed events. On `truncated`, reset the stored offset to 0 (a
diagnostics note is recommended, per ARCHITECTURE.md §5.2).

## Non-goals

- No parsing — lines go to `@eqlcc/log-parser`.
- No offset/watermark storage (above).
- No inode tracking; truncation is inferred from length alone (documented
  possible future refinement).

## Example

```ts
import { TailManager } from "@eqlcc/log-tailer";

const manager = new TailManager({
  logsDir: "C:/EQL/Logs",
  maxFiles: 3,
  resolveStartOffset: (file) => db.storedOffset(file.path) ?? 0,
});
manager.on("lines", ({ fileId, lines, watermark }) => {
  const events = parse(lines);
  db.commitBatch(fileId, events, watermark); // one transaction: events + watermark
});
manager.on("truncated", ({ fileId }) => db.resetOffset(fileId));
manager.start();
```
