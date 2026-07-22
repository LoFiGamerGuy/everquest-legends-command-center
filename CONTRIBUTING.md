# Contributing

## Ground rules

1. **Compliance gate.** Read docs/COMPLIANCE_BOUNDARIES.md first. PRs that add memory reading, injection, hooking, packet analysis, input automation, proprietary-format unpacking, or game-directory writes will be closed. Expanding any boundary requires owner approval recorded in docs/DECISION_LOG.md.
2. **Fixture policy.** Every parser rule needs at least one fixture and test. Fixtures must be **anonymized**: player and pet names replaced (Playerone/Petone…), account/server-identifying details scrubbed; mob/spell/zone/item names and all numbers preserved exactly. Never commit raw player logs (`.gitignore` blocks `eqlog_*.txt`). Use `scripts/sanitize-log.ts`; validate with `scripts/validate-fixtures.ts`.
3. **Never fabricate a log format.** A recognizer without a real captured fixture doesn't merge. Mark speculative formats UNVERIFIED in docs/LOG_FORMAT_SPEC.md.
4. **Preserve raw line + byte offset** on every event. Unmatched lines are retained as RawUnknown — parser failures must be visible, measurable, recoverable.
5. **Migrations for every schema change** (numbered, forward-only). See docs/DATA_MODEL.md.
6. **Explicit uncertainty beats guessed attribution.** Pet/charm damage is attributed only with evidence (docs/DATA_MODEL.md evidence/confidence pattern).

## Workflow

- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`; scope encouraged: `feat(parser): …`).
- Semantic versioning. Branch from `main`; no direct pushes to `main`; all merges via PR with human approval.
- PRs: fill the template; CI (lint, typecheck, tests, build, security) must pass; tests and acceptance criteria pass before a task is called done.
- Architecture decision records for significant choices → docs/DECISION_LOG.md. Keep docs synchronized with implementation.
