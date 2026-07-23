# Launch Dialect Readiness Plan

**Status:** Draft v1 (2026-07-23) · Owner: HQ · Implements: issue #22
**Deadline context:** EverQuest Legends launches **2026-07-28** (5 days). Launch wipes beta characters and will very likely shift the log format away from the current `eql-beta-2026-07` dialect (EQ precedent: the 2018 TBL log overhaul changed many lines). The parser today verifies one dialect at 0.73% unmatched on the beta corpus. The goal of this work is that **adding an `eql-launch-2026-07` dialect is a data update — new fixtures + rules — not a code rewrite**, and that we can *detect and measure* dialect drift the moment launch logs arrive.

## 0. What already exists (main)

- Every recognizer rule carries `{ ruleId, dialectId, frequencyRank }` (`rule.ts`), defaulting to `DIALECT_EQL_BETA_2026_07`.
- A recognizer `registry` ("all rules for a dialect", `registry.ts`) and a `parser` that tags each event's `dialectId`.
- Unknown-line shape stats (`unknown-stats.ts`) and a triage CLI (`cli.ts`).

What's missing and this ticket adds: **plural dialects**, a **detector**, a **drift report**, and a **per-dialect benchmark gate** — all backward-compatible (beta stays the default; no behavior change for existing callers).

## 1. Dialect model (plural, backward-compatible)

- A `Dialect` is `{ id: DialectId, rules: Rule[], baseline?: DialectBaseline }`. Register named dialects in a `DialectRegistry`; `eql-beta-2026-07` is registered from the current rule set unchanged.
- A new launch dialect is authored as `eql-launch-2026-07`: it **extends** beta (reuses every beta rule whose wording is unchanged) and **overrides/adds** only the rules whose wording drifted. Rule identity is `ruleId`; a launch rule with the same `ruleId` supersedes the beta one within the launch dialect. This keeps the diff to just the lines that actually changed.
- Events already carry `dialectId`; downstream (projections) already order/segment dialect-agnostically, so tagging is sufficient — no schema change.

## 2. Detection (which dialect is this log?)

`detectDialect(sampleLines, registry) → { dialectId, confidence, perDialectUnmatchedRate }`:
1. **Explicit marker (preferred, if it exists):** if the client writes a version/build line to the log (UNVERIFIED — confirm at launch), map it directly. Cheap and exact.
2. **Best-match fallback (always available):** run a sample (first + a random slice, ~2–5k lines) through each registered dialect's recognizer set; pick the dialect with the **lowest unmatched rate**. Ties or all-poor (> a `DRIFT_ALERT_RATE`, default 5%) → return `unknown` + the rates, so the caller can flag "possible new dialect" rather than silently mis-parsing.
3. Default when only one dialect is registered: that dialect (today, beta) — zero behavior change.

Detection is per-log-file and cached; the orchestrator/projectors consume `dialectId` as today.

## 3. Drift detection & triage SLA

The launch risk is not "no matches" — it's *partial* drift where a few high-frequency families change wording and silently become `raw_unknown`. So we monitor **per-family match health**, not just the overall rate.

- **Baseline:** each dialect ships a `DialectBaseline` — the expected share of lines per event family (captured from its verified corpus; for beta, the family distribution behind the 0.73% figure). Committed as data.
- **`driftReport(stats, baseline) → DriftReport`:** compares an observed run against the baseline and flags: (a) overall unmatched rate > `DRIFT_ALERT_RATE`; (b) any **verified** family whose observed share drops by more than `FAMILY_DROP_THRESHOLD` (default 50% relative) — the signature of "this family's wording changed"; (c) the top new unknown shapes (normalized, anonymized) sorted by frequency, ready to become fixtures.
- **Triage SLA (launch playbook, §5):** at launch, run `driftReport` on the first real logs; any red flag becomes a fixture-promotion task with a target turnaround, tracked against #22.

## 4. Per-dialect benchmark gate

- `benchmark(dialect, corpusDir) → { lines, unmatched, rate, perFamily }`. CI target: **< 2% unmatched per registered dialect** (beta already 0.73%). When `eql-launch-2026-07` is added, its own fixtures must clear the same bar before that dialect is considered ready.
- The existing corpus benchmark stays beta's gate; the launch gate activates when launch fixtures exist. No real player logs are committed — benchmarks run against the owner's private corpus locally (device) and anonymized fixtures in CI.

## 5. Launch-day playbook (executed 2026-07-28+; ties to the scheduled task)

The scheduled launch-day task (`trig_01NDBWoNMz4Fa75Khw3Euh2M`, fires 2026-07-28 14:00 UTC) already: re-diffs ToS/EULA, and if the device is connected, re-inventories the install and samples launch logs. This plan defines what happens next with those samples:

1. **Detect:** run `detectDialect` on the first post-launch log. If it best-matches beta at < 2%, the format is stable — celebrate, tag as beta-compatible, done. If not, proceed.
2. **Diff:** run `driftReport` vs the beta baseline → the ranked list of changed families + new unknown shapes.
3. **Author `eql-launch-2026-07`:** for each drifted family, capture a real line, **anonymize** it (player→PlayerN, pet→PetN; mobs/spells/numbers exact — per CONTRIBUTING fixture policy), add it as a launch fixture, and write/override the recognizer rule under the launch dialect. Reuse every unchanged beta rule.
4. **Verify:** launch benchmark < 2% unmatched; every new rule has a fixture + golden test; dual-family review (Claude + Codex) as usual.
5. **Cut over:** register the launch dialect; the detector routes post-launch logs to it automatically; beta logs (historical) still parse under beta.

Estimated scope if drift is moderate (a few dozen changed lines): a single fixture+rule PR, hours not days — which is the entire point of building the machinery now.

## 6. This ticket's deliverables (cloud-buildable now, before launch)

- `DialectRegistry` + plural-dialect support in `@eqlcc/log-parser` (beta registered unchanged; API additive, backward-compatible).
- `detectDialect`, `driftReport`, `benchmark` functions + a `DialectBaseline` type; beta baseline captured as data.
- CLI extension: `--drift` / `--detect` modes over a log file (anonymized shape output only).
- Tests on **synthetic** fixtures: a beta sample detects as beta; a synthetic "drifted" sample (a few families' wording changed) detects as `unknown`/low-confidence and `driftReport` flags exactly the changed families + surfaces the new shapes; benchmark math; backward-compat (existing single-dialect parse unchanged).
- This plan doc.

**Out of scope until launch logs exist:** the actual `eql-launch-2026-07` rules/fixtures (there's nothing real to author yet — that's §5, executed on/after the 28th). Building rules against guessed launch wording would violate the never-fabricate-a-log-format rule.

## 7. Open questions (confirm at launch)

Does the launch client write a build/version marker to the log (enables §2.1 exact detection)? Does the wipe change the `eqlog_<Char>_<server>.txt` naming or Logs dir? Are difficulty tiers (D0–D4) surfaced in launch logs (RESEARCH_BACKLOG)? All default to the best-match fallback and null/user-supplied until observed.
