# Approved Stage 0 Backlog — ready to file as GitHub issues

(API issue creation is blocked from the HQ sandbox; paste these as issues, or HQ will file them once API access is enabled. Milestones: M0–M3 per docs/ROADMAP.md.)

## M0 (foundation close-out)
1. **compliance: human-verify ToS/EULA clause quotes; schedule launch-day re-diff (2026-07-28)** — owner re-reads clicked-through beta agreement (LEGAL Q1). Owner + compliance-auditor.
2. **audit: complete native hashing of install** — run `scripts/hash-eql-install.ps1` on Windows (resumable); import into sqlite manifest; confirm duplicate-files report by hash. Owner-run; local-only.
3. **audit: plaintext keyword sweep + PE metadata pass** — `scripts/search-readable-resources.py` over 3,445 A/B/C files; version/signature/imports for 29 D binaries; `.pak` magic identification. Local-only outputs under data/.
4. **build: real toolchain** — pnpm or npm workspaces + TypeScript + ESLint + Vitest wired into ci.yml stubs. release-engineer.
5. **repo: enable branch protection on main** (settings below). Owner.

## M1 — Parser core
6. **event-schema: typed append-only event model** per docs/DATA_MODEL.md (30-type enum, raw line + byte offset on every event). parser-specialist. AC: types compile, exhaustiveness-checked, documented.
7. **log discovery + resumable tailer** — Logs-dir scan (`eqlog_<Char>_<server>.txt`), byte-offset watermarks, truncation reset, poll+events hybrid; Node test harness. parser-specialist. AC: kill/restart resumes without loss or duplication (idempotent re-ingestion test).
8. **recognizers for all VERIFIED families** (LOG_FORMAT_SPEC.md §families) with ≥1 anonymized fixture + golden test each; most-frequent-first ordering; dialect tag eql-beta-2026-07. parser-specialist + qa-regression. AC: all fixtures green in CI.
9. **entity & pet resolver** — evidence/confidence model (pet_chatter 0.95, ds_possessive 0.7, name_pattern 0.4, user_assertion 1.0); persistent registry; user-correctable. parser-specialist. AC: pet damage attributed in corpus test with evidence rows.
10. **SQLite ingestion + migrations** — events + projections per DATA_MODEL.md; transactional watermark commit. data-engineer. AC: full-corpus ingest deterministic and rebuildable.
11. **unmatched-line diagnostics** — RawUnknown retention, shape-normalized aggregation, triage report (CLI). parser-specialist. AC: unmatched rate measured on corpus.
12. **corpus benchmark** — parse owner's full 434k-line beta corpus; target <2% unmatched; publish (anonymized) unknown-shape stats to RESEARCH_BACKLOG. qa-regression.
13. **research: capture missing line families in-game** — skill-ups, own death/rez, AA gain, negative faction, /who, crits, difficulty-tier markers (RESEARCH_BACKLOG list). Owner + research-and-evidence-auditor.

## Branch protection settings for `main` (Settings → Branches → Add rule)
Require a pull request before merging (1 approval) · Require status checks to pass (build-test, guard-no-raw-logs, gitleaks) · Require branches to be up to date · Block force pushes · Block deletions · Do not allow bypassing (optional: leave admins exempt while solo).
