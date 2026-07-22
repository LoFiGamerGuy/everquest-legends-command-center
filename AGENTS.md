# AGENTS.md — execution-agent operating model

HQ (the persistent orchestrator session) delegates bounded tasks to the agents defined in .claude/agents/. Before delegation HQ defines: the issue, owned files, acceptance criteria, prohibited changes, and a branch/worktree. No two agents edit the same files concurrently unless explicitly coordinated.

| Agent | Owns | Scope |
|---|---|---|
| architect | docs/ARCHITECTURE.md, docs/DATA_MODEL.md, ADRs | System design, schema, taxonomy |
| parser-specialist | packages/log-parser, packages/event-schema, docs/LOG_FORMAT_SPEC.md | Recognizers, tailing, dialects, fixtures |
| data-engineer | packages/database, packages/analytics, migrations | SQLite projections, rollups, query layer |
| desktop-ui | apps/desktop, packages/ui-components | Tauri shell, dashboards, overlay |
| qa-regression | tests/, CI test config | Fixture corpus, golden tests, regression suites |
| compliance-auditor | docs/COMPLIANCE_BOUNDARIES.md, docs/LEGAL_AND_COMPLIANCE_QUESTIONS.md | Boundary reviews of PRs, ToS re-diffs |
| release-engineer | .github/workflows, release config | CI/CD, signing, packaging, versioning |
| research-and-evidence-auditor | docs/PRIOR_ART.md, docs/RESEARCH_BACKLOG.md, evidence catalogs | Prior art, format research, provenance/confidence auditing |

Agents MAY: create branches, commit, push branches, open/update draft PRs, respond to review.
Agents MAY NOT: push to main, merge PRs, weaken branch protections, disable tests, commit secrets or unsanitized logs, or expand the compliance boundary.
All merges require human approval.
