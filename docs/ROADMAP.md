# Roadmap

## M0 — Repository & evidence foundation (Stage 0) — DONE 2026-07-22 (audit ongoing)
Governance, documentation skeleton, compliance research + boundaries, architecture/data-model/log-format-spec v0, prior-art audit, fixture policy, read-only installation inventory (manifest + classification), CI skeleton.

## M1 — Parser core
Log discovery & resumable tailing (byte offsets, truncation detection) · line normalization · recognizers for all VERIFIED families (melee hit/miss, spell damage, DoT, damage shield, environmental, heals, rune, kills/deaths, XP/level, AA purchase, loot both forms, coin, zone, stance, invocation, casting, faction, pet chatter, chat, log toggle) · typed event stream with raw line + offset · entity & pet resolver (evidence + confidence) · unmatched-line diagnostics & triage · fixture corpus + golden tests + CI.
**Acceptance:** parse Ryan's full 434k-line beta corpus with <2% unmatched; deterministic re-runs byte-identical; every recognizer has fixtures/tests.

## M2 — Desktop session tracker
Tauri shell · character auto-detection from Logs dir · session start/stop/auto · live dashboard (DPS/HPS, encounters, kills/deaths, XP/hr incl. active-vs-AFK, loot/coin) · encounter list with drill-down to raw lines · damage/healing breakdowns (pet rollup toggle) · export (privacy-safe) · local settings · compact always-on-top mode.

## M3 — EQL research command center
Stance/invocation comparisons · class-trio timelines · weapon & AA experiments (EXPERIMENT_DESIGN.md) · route analysis · customizable dashboards · screenshot evidence inbox · provenance & confidence tracking · evidence catalogs (AA/spells/items) user-confirmed against gameplay.

## Later
Trigger/alert system (GINA-import path) · plugin/dialect SDK · localization · macOS support hardening.
