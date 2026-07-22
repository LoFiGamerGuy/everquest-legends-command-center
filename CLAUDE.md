# CLAUDE.md — instructions for AI agents in this repo

You are working on EQL Command Center: a local-first, strictly passive, read-only EverQuest Legends log parser/tracker/analytics desktop app (Tauri 2 + React + TS + SQLite; parser core is pure TS in packages/log-parser).

## Hard rules (non-negotiable)

- docs/COMPLIANCE_BOUNDARIES.md is a hard constraint. Never implement: memory reading, injection, hooks, packet capture, input automation, proprietary-format decoding/unpacking, game-directory writes, or anything granting unfair gameplay advantage. Never weaken this boundary; escalate to the human owner instead.
- Never fabricate an EQL log line format. Recognizers require a real, anonymized fixture in tests/fixtures + a test. Unknown formats → docs/LOG_FORMAT_SPEC.md marked UNVERIFIED.
- Never commit: secrets, raw player logs (eqlog_*.txt), anything under data/, or content derived from game binaries/proprietary containers.
- Never push to main, merge PRs, disable tests, or weaken branch protections. Work on a branch, open a draft PR, request review. All merges are human-approved.
- Every event preserves raw line + source byte offset. Every DB schema change is a numbered forward-only migration. Attribution requires evidence + confidence, never silent guessing.
- Do not mark work complete unless tests and acceptance criteria pass.

## Orientation

- docs/ARCHITECTURE.md — pipeline & process model. docs/DATA_MODEL.md — schema & migrations. docs/LOG_FORMAT_SPEC.md — verified line formats (the parser contract). docs/PRIOR_ART.md — licensing: MIT/Apache sources may be adapted with attribution; ACT core, GINA, EQL Tools JS, GamParse are no-copy.
- Agent roles & ownership: AGENTS.md and .claude/agents/*.
- Log dialect is versioned (eql-beta-2026-07 → launch dialects); beta format churn is expected — treat unmatched-line rate as a health metric.
