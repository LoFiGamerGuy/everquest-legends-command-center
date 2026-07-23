# EQL Command Center — Architecture

**Status:** Draft v0.1 (2026-07-22) · **Audience:** contributors
**Scope:** component architecture, process model, tailing design, dialect versioning, diagnostics, and key decisions (ADRs).

EQL Command Center is a local-first, strictly **passive** (read-only) log parser, session tracker, and
analytics desktop app for EverQuest Legends. It never injects into, automates, or communicates with the
game client. Its only input is the log file the game itself writes; its only outputs are a local SQLite
database and a local UI.

---

## 1. Design principles

1. **Passive and read-only.** We open log files with read-only access. No game memory, no network to game
   servers, no input automation. This is a hard product constraint, not a default.
2. **Local-first.** No cloud account, no telemetry. All data lives in a per-user SQLite database.
3. **Deterministic parsing.** Same bytes in → same events out, independent of wall clock, machine, or
   replay vs. live tailing. Every nondeterministic input (e.g., "now") is injected, never sampled inside
   the parser.
4. **Append-only, lossless event model.** Parsed output is a typed, append-only event stream. Every event
   preserves the original raw line and its source byte offset. Every line we cannot classify is retained
   as a `RawUnknown` event — nothing is dropped.
5. **Evidence over guesses.** Derived facts (pet ownership, kill attribution, encounter membership) carry
   `evidence_type` and `confidence`, and are user-correctable. We never silently guess.
6. **Built for format churn.** EQL is in beta and its log format WILL change. Parser rules are versioned
   by dialect (see §6) and validated against committed fixtures.

---

## 2. Package layout → components

```
eql-command-center/
├── apps/
│   └── desktop/            # Tauri 2 shell: Rust main process + React webview
├── packages/
│   ├── event-schema/       # TS types: event enum, payload interfaces, dialect tags. Zero deps.
│   ├── log-parser/         # Pure-TS parser core: normalization, recognizers, entity/pet
│   │                       #   resolver, encounter/session state engine. Node-runnable.
│   ├── database/           # SQLite schema, migrations, projection writers, driver abstraction
│   ├── analytics/          # DPS/HPS/XP-rate computations over projections; pure functions
│   └── ui-components/      # React components (meters, timelines, entity manager, diagnostics)
├── docs/                   # This document, DATA_MODEL.md, LOG_FORMAT_SPEC.md
└── tests/fixtures/         # Anonymized real log excerpts, keyed by dialect version
```

Dependency rules (enforced in CI):

- `event-schema` depends on nothing.
- `log-parser` depends only on `event-schema`. **No Tauri, no DOM, no SQLite imports.** It must run in
  Node for the CLI and tests, in a Web Worker inside the Tauri webview, and (later) anywhere else.
- `database` depends on `event-schema`; it defines a `SqlDriver` interface with two implementations:
  `better-sqlite3` (Node/tests/CLI) and `tauri-plugin-sql` (desktop).
- `analytics` depends on `event-schema` + `database` read models only.
- `ui-components` depends on `event-schema` + `analytics`; never on `log-parser` internals.
- `apps/desktop` wires everything together and owns all Rust code.

---

## 3. Pipeline

```
 game writes log file (append-only, mostly)
        │
 [Rust] file watcher / tailer  ── byte chunks + offsets ──►  (Tauri event channel)
        │
 [TS worker] line normalization        split into complete lines; carry (file_id, byte_offset, raw)
        │
 [TS worker] event recognizers         ordered rule list per dialect → typed event or RawUnknown
        │
 [TS worker] entity & pet resolver     name → entity id; kind classification; pet→owner links
        │                              (evidence + confidence, user-correctable)
 [TS worker] encounter/session engine  sessions, zone visits, group-wide encounters,
        │                              back-dated encounter end
 [SQLite]   append events + update projections (in one transaction per batch)
        │
 [TS]       analytics (DPS/HPS/XP rollups; incremental + full-rebuild)
        │
 [React]    UI  /  [Node CLI] headless output (JSON/NDJSON)
```

Stages 2–5 live entirely in `packages/log-parser` and are pure: they accept lines/events in and emit
events/state transitions out. Side effects (fs, SQLite, Tauri IPC) live at the edges.

---

## 4. Process model

| Context | Runs | Responsibilities |
|---|---|---|
| **Tauri main (Rust)** | file watcher/tailer sidecar module | Discover `eqlog_*_*.txt` files, tail by byte offset, detect truncation/rotation, stream raw chunks + offsets to the webview via Tauri events. Also hosts `tauri-plugin-sql` (SQLite). |
| **Webview — Worker (TS)** | parser core from `packages/log-parser` | Normalization → recognizers → resolver → encounter engine. Emits typed event batches. Kept off the UI thread in a Web Worker. |
| **Webview — main thread (React)** | `ui-components` + app shell | Rendering, user corrections (entity reclassification), settings. Talks to the worker via `postMessage` and to SQLite via the plugin. |
| **Node (dev/CI)** | CLI + tests | Same parser core fed by `fs` streams; same `database` package via `better-sqlite3`. Replays fixtures deterministically; powers golden-file tests. |

Rust is used **only** where Tauri/filesystem integration requires it (watching, tailing, offsets,
truncation checks). All parsing logic stays in TypeScript so that one implementation serves Node CLI,
tests, and the desktop app (see ADR-1).

---

## 5. Tailing design

Community experience with EQ-family log tools (notably eql-meter's Tauri 2 + Rust tailer and
rumstil/eqlogparser) shows that OS file events alone are **unreliable** for game logs — editors,
antivirus, and the game's own buffered writes cause missed or coalesced notifications. We therefore use
a **hybrid**:

- **Poll every 200 ms** (configurable 150–250 ms) — `stat` the file, compare length to our watermark.
- **Also subscribe to fs notifications** (`notify` crate) to react faster when they do fire.
- Whichever fires first triggers a read; reads are idempotent because they are offset-driven.

Per tracked file we persist a **byte-offset watermark** in `log_files.byte_offset` (see DATA_MODEL.md):

1. **Resume:** on startup, seek to the stored offset and continue. Historical backfill (offset 0) is an
   explicit user action per file.
2. **Truncation / rotation:** if `current_length < stored_offset`, the file was truncated or replaced
   (players commonly delete logs; the game recreates them). **Reset offset to 0** and continue. This is
   the same rule eql-meter ships and it is the only safe interpretation without inode tracking; we log a
   `diagnostics` note when it happens. (Inode/file-id comparison is a possible future refinement.)
3. **Partial lines:** we only emit complete lines (terminated by `\n`; tolerate `\r\n`). Trailing bytes
   without a terminator stay buffered in the tailer; the watermark only advances past fully-emitted
   lines, so a crash never splits a line.
4. **Watermark commit:** the offset watermark is written in the **same SQLite transaction** as the events
   parsed from those bytes. Crash-safety therefore reduces to SQLite durability: we either have the
   events and the advanced offset, or neither. Re-parsing a batch after a crash is impossible by
   construction; if it ever happened it would be harmless anyway because parsing is deterministic and
   events carry `(log_file_id, byte_offset)` as a uniqueness key.
5. **Multiple files:** the watcher tracks every `eqlog_<Character>_<server>.txt` in the configured Logs
   directory; each file is an independent tail with its own watermark. Only files the user enables are
   ingested.
6. **Encoding:** decoded as Windows-1252 with lossless fallback (classic EQ logs are not UTF-8; EQL is
   UNVERIFIED — see LOG_FORMAT_SPEC.md open questions). Raw bytes are what the offset counts; decoding
   happens after slicing.

---

## 6. Dialect versioning (format churn strategy)

EQL is in beta; message wording, punctuation, and field order will change between patches. We treat the
log format as a **versioned dialect**, not a constant:

- Every recognizer rule carries a `dialect` tag: `{ id, introduced: "eql-beta-2026-07", retired?: ... }`.
- The active **dialect set** is chosen per log file (default: latest known; overridable). Rules from
  retired dialects remain in the codebase so historical files still parse.
- Every emitted event records `dialect_id` and `rule_id`, so any parse can be traced to the exact rule
  and fixture that justified it.
- **Fixtures are the contract.** A rule may only be added or changed alongside an anonymized fixture line
  in `tests/fixtures/<dialect>/`. Golden-file tests replay every fixture through the full pipeline and
  diff the typed output. A format change after a game patch shows up as (a) fixture tests still passing
  (old dialect intact) and (b) live unmatched-rate spiking (new dialect needed) — which is exactly the
  signal we want.
- Rules within a dialect are ordered **most-frequent-first** (melee, DoT, heals before zone/faction/
  loot), a measured win from rumstil/eqlogparser. Ordering is data, not code: a per-dialect manifest.

---

## 7. Error handling & diagnostics

- **Unmatched-line rate is a first-class health metric.** The parser counts matched vs. unmatched lines
  per file per session. The UI surfaces it permanently (status bar) and warns above a threshold
  (default 2%). A sudden spike is the primary "the patch changed the format" alarm.
- **`RawUnknown` retention.** Every unmatched line becomes a `RawUnknown` event with raw text + offset,
  and is additionally aggregated by normalized shape (numbers → `#`, quoted strings → `'…'`) into
  `unknown_line_stats` so users can see "top 20 unknown shapes" and paste them into a GitHub issue as
  ready-made fixture candidates.
- **Recognizer errors never abort the stream.** A throwing rule is disabled for the session, logged, and
  its lines fall through to `RawUnknown`.
- **Determinism checks in CI:** parse each fixture twice (stream-chunked at random boundaries vs. whole
  file) and require byte-identical event output.
- **No telemetry.** Diagnostics stay local; sharing is manual copy/export by the user.

---

## 8. Architecture decision records (condensed)

**ADR-1 — Parser core in TypeScript, not Rust.**
One parser implementation must serve tests, a Node CLI, and the desktop app. Rust would be faster but
would either duplicate logic in TS for the UI or force all analytics through IPC. Throughput of a text
log parser in modern JS (with fixed-offset timestamp slicing, ADR-2) is far beyond EQL's line rate;
historical backfill of multi-hundred-MB logs is the only heavy case and is acceptable as a background
task. Rust is confined to tailing. *Revisit only if backfill benchmarks show >5 min for a 500 MB file.*

**ADR-2 — Fixed-offset timestamp slice; recognizers ordered most-frequent-first.**
Per rumstil/eqlogparser: the `[Day Mon DD HH:MM:SS YYYY] ` prefix is fixed-width, so we slice
`line[1..25]` and parse the date without regex, then run message-body recognizers ordered by observed
frequency. Anchored regexes with named capture groups per rule; first match wins.

**ADR-3 — Append-only event log + rebuildable projections.**
`events` is the source of truth and is never updated or deleted. Encounters, entity links, and DPS/HPS
rollups are projections that can be rebuilt from events at any time (e.g., after a resolver improvement
or a user correction). This makes user-facing corrections cheap and bugs recoverable.

**ADR-4 — Group-wide encounters (fixing a known limitation).**
eql-meter opens a fight only on damage by *you or your pet*. We instead open an encounter on **any**
hostile combat event involving a tracked participant, so group members' contributions are captured.
Encounter close: inactivity timeout (15 s group / 2 min raid-scale, per rumstil's tuning) with the end
time **back-dated to the last combat event** (per eql-meter) so idle time never dilutes DPS.

**ADR-5 — Persistent pet map with evidence, not session-only.**
eql-meter keeps pet→owner in memory per session; kauffman12's EQLogParser proves users want persistent,
correctable "Verified Players / Verified Pets" lists. We persist pet→owner links in SQLite with
`evidence_type` (pet chatter, damage-shield possessive, name-pattern match, user assertion) and
`confidence`; the UI exposes reclassification, and user assertions always outrank heuristics.

**ADR-6 — SQLite via `tauri-plugin-sql` in-app; `better-sqlite3` in Node — behind one driver interface.**
Keeps `database` logic (migrations, projections, queries) in shared TS while using each runtime's
native SQLite. The driver interface is deliberately tiny (exec, query, transaction). *Noted alternative:*
all DB access in Rust with IPC — rejected for now because it splits projection logic across languages.

**ADR-7 — Forward-only numbered migrations.** See DATA_MODEL.md §1. Local-first apps can't run
coordinated rollbacks; recovery path is "rebuild projections from events", not "migrate down".

**ADR-8 — Hybrid poll (150–250 ms) + fs events for tailing.** Community-validated (eql-meter); events
alone miss writes, polling alone adds latency. Both, idempotent by offset. See §5.

**ADR-9 — Anonymized fixtures only.** Committed fixtures replace player names with `Playerone…` and pet
names with `Petone…`; mob/spell/zone/item names and all numbers/structure are preserved exactly.
Fabricated lines are never committed — every fixture traces to a captured real line.

**ADR-10 — Analytics dimensions are first-class columns, not afterthoughts.**
EQL analytics that matter to players: difficulty tier (D0–D4), stance × invocation, class trio, level,
zone. Stance/invocation changes are events (verified in logs), so rollups can segment by the active
stance/invocation at event time. Difficulty tier and class detection are currently UNVERIFIED in logs —
modeled as nullable columns populated when a log source or user input provides them.

---

## 9. Non-goals (v1)

- No overlay injected into the game window (a separate always-on-top Tauri window is acceptable).
- No cloud sync, accounts, or uploads.
- No write access to game files or settings.
- No live network capture of any kind.
