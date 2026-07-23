# Decision Log (ADRs)

## ADR-001 · 2026-07-22 · Broader read-only installation audit approved
Owner approved the comprehensive read-only inventory policy (hashes, PE metadata, archive metadata, strings searches; classification A–H; hard stops at F–H) over the narrow filename/size/plaintext-only variant. Constraints: local-only results, nothing binary-derived published, stop-and-ask before any proprietary-format work. See COMPLIANCE_BOUNDARIES.md #7–#11, LEGAL_AND_COMPLIANCE_QUESTIONS.md Q2–Q4.

## ADR-002 · 2026-07-22 · GitHub remote as durable home; protected main; human-only merges
Repo: github.com/LoFiGamerGuy/everquest-legends-command-center. Agents work on branches + draft PRs; merges human-approved.

## ADR-003 · 2026-07-22 · TypeScript parser core; Rust confined to tailer
One parser implementation runs in Node (CLI/tests/CI) and the Tauri webview worker. Rust only for file watching/tailing via Tauri. Rationale: single-source recognizers, fixture tests in CI without a Rust toolchain, JS regex parity with UI.

## ADR-004 · 2026-07-22 · Dialect-versioned recognizers (eql-beta-2026-07 first)
Beta format churn is expected (EQ precedent: 2018 TBL log overhaul). Every rule carries a dialect tag; events record dialect + rule id.

## ADR-005 · 2026-07-22 · Append-only events as source of truth; projections rebuildable
See DATA_MODEL.md. Watermark commits transactionally with events; UNIQUE(log_file_id, byte_offset) for idempotent re-ingestion.

## ADR-006 · 2026-07-22 · Evidence/confidence model for all attribution
Pet→owner links: pet_chatter 0.95 / damage_shield_possessive 0.7 / name_pattern 0.4 / user_assertion 1.0; user-correctable with audit trail (kauffman12 precedent).

## ADR-007 · 2026-07-22 · MIT license
Compatible with adapting MIT (eql-meter) and Apache-2.0 (rumstil, kauffman12) sources with attribution; maximizes community reuse.

## ADR-010 · 2026-07-23 · Cross-family review layer
Owner directed cross-model review wherever available. Policy: every substantive PR gets (1) an independent Claude-family review agent (fresh context, must re-run gates/benchmarks), and (2) where tooling permits, a cross-family static review (OpenAI Codex CLI and/or Google Gemini CLI, run on the owner's machine with the owner's accounts). Cross-family findings enter the same fix-and-re-review loop. Rationale: same-family reviewers can share blind spots with authors. Merge authority remains exclusively human.

## ADR-009 · 2026-07-23 · Beta-NDA caution lifted after owner review
The owner reviewed the beta agreement he actually accepted and confirmed no surviving restrictions apply to this project's use of beta-derived data. LEGAL Q1 resolved; beta-corpus fixtures usable/publishable under standing anonymization + no-binary-derived-content rules. Launch-client regeneration downgraded from compliance requirement to good practice.

## ADR-008 · 2026-07-22 · Publication boundary
Public repo/releases contain no game-binary-derived data. data/ gitignored. Binary-inventory scripts are owner research tools, not shipped features. Regenerate reference data from launch client post-2026-07-28 (beta NDA uncertainty, Q1).
