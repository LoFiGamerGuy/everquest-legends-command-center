# @eqlcc/log-parser

Pure-TypeScript parser core for EQL Command Center (ARCHITECTURE.md §2–§3).
Depends only on `@eqlcc/event-schema` — no Tauri, no DOM, no SQLite — so the
same implementation runs in Node (CLI/tests) and in the desktop Web Worker.

## What's inside

- `line-reader.ts` — incremental line splitting with byte-offset watermarks
  (`\n`/`\r\n`, partial lines buffered; latin1 decode ⇒ 1 char = 1 byte).
- `timestamp.ts` — fixed-offset asctime slice (`line[1..25]`, message at 27),
  no regex on the hot path; malformed prefix ⇒ `raw_unknown`.
- `rule.ts` / `registry.ts` — dialect-tagged recognizer rules
  (`{ruleId, dialectId, frequencyRank}`), anchored named-group regexes or
  exact-string dictionaries, ordered most-frequent-first (corpus-measured);
  first match wins; a throwing rule is disabled for the session.
- `recognizers/` — one module per event family, `eql-beta-2026-07` dialect.
  Every rule is backed by an anonymized fixture in
  `tests/fixtures/eql-beta-2026-07/` and a golden in `tests/goldens/`.
- `unknown-stats.ts` — shape-normalized aggregation of unmatched lines
  (digits→`#`, quotes→`'…'`, names→`Name`) for the top-N triage report.
- `cli.ts` — headless parse/triage:
  `node packages/log-parser/dist/src/cli.js <logfile…> [--top N]` prints total
  lines, events by type, unmatched count/rate, and top unknown shapes.

## Benchmark (July 2026 beta corpus, 9 files / 434,502 lines)

Overall unmatched rate **0.73%** (target <2%, ARCHITECTURE.md §7); worst file
2.04%. The remaining tail is one-off NPC roleplay/death emote wording —
per-mob spell-data text that is deliberately *not* pattern-matched (fixture
policy: we never invent formats).

## Rules

Fixtures are the contract: a recognizer changes only together with a captured,
anonymized fixture line and its golden. Unknown lines are never dropped — they
become `raw_unknown` events and feed `unknown_line_stats`.
