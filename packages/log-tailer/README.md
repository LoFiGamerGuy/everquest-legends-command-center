# @eqlcc/log-tailer

Log discovery and resumable byte-offset tailing for EQL Command Center
(ARCHITECTURE.md §5 "Tailing design"). Pure TypeScript over Node builtins
(`node:fs`, `node:path`, `node:events`) — no Tauri, no DOM, no SQLite.

This package is the **Node-context reference implementation of the tailing
contract**: it serves the Node CLI, tests, and headless replay. In the
desktop app, ARCHITECTURE.md §4/ADR-1 places live tailing in the Rust/Tauri
sidecar (planned for M2), which mirrors this contract — same watermark
semantics, truncation rule, hybrid scheduling, and complete-lines-only
guarantee — and streams chunks+offsets to the webview.

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
  - **Runaway lines are bounded:** a partial line that grows past
    `maxLineBytes` (default 1 MiB) is flushed with `overflow: true` and the
    watermark advances past it, so a never-terminated line cannot grow
    memory forever. **Every fragment of an overflowed physical line carries
    `overflow: true`** — the flushed buffers *and* the terminal
    newline-terminated remainder — because none of them is a complete
    parseable line. Downstream MUST route `overflow` fragments to
    `RawUnknown` and never feed them to recognizers. Offsets stay
    byte-true; the flag clears with the first line that starts after the
    overflowed line's terminator.
  - **Consumer failures never skip bytes:** if a `lines` listener throws,
    the batch counts as *not consumed* — the tailer rewinds its in-memory
    state to the batch start, emits a distinct `consumer-error` event
    (never conflated with the file-I/O `error` event), aborts the current
    pass, and replays the identical batch on the next poll. The watermark
    therefore never advances past a batch the consumer failed to accept. A
    persistently throwing listener re-delivers the same batch once per poll
    interval until it is accepted or detached.
- **`TailManager`** — discovery + one `LogTailer` per selected file (the N
  most recently modified, or all), re-emitting events tagged with a stable
  `fileId` (the resolved absolute path — the same identity `log_files.path`
  uses). `rescan()` reconciles against the fresh mtime ranking: newly
  selected files start tailing, files that fell out of the top N (or
  vanished) have their tailer stopped cleanly, and files kept across the
  scan keep their live tailer (offsets are never reset by a rescan).

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

## Known limitations

- **Shrink-then-regrow within one poll window is undetectable.** Truncation
  is inferred from length alone (`observed length < read position`). If a
  file is truncated **and** regrows past the watermark between two polls,
  the observed length never drops below the read position, so the replaced
  prefix is neither re-read nor flagged and subsequent reads are misaligned
  until the next detectable truncation. Closing this hole requires
  inode/file-id or creation-time tracking, which ARCHITECTURE.md §5.2
  explicitly defers as a future refinement. In practice the window is one
  poll interval (~200 ms) and the game recreates deleted logs from empty, so
  regrowing past a nontrivial watermark that fast is unrealistic.
- An `fs.watch` handle that cannot be established (file not yet created) or
  that dies is re-attached lazily on the next successful poll; in the
  meantime the poll alone drives tailing (it is the source of truth anyway).

## Non-goals

- No parsing — lines go to `@eqlcc/log-parser`.
- No offset/watermark storage (above).
- No inode tracking (see Known limitations).

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
