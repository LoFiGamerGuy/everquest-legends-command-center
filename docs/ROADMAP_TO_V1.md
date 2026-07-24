# Roadmap to v1.0 (First Final Version)

**Status:** Living plan · Last updated 2026-07-23 · Owner: HQ + LoFiGamerGuy
**Companion to:** `ROADMAP.md` (milestone summary), `PRODUCT_VISION.md` (what v1 is), the planning review (issue #18), and the per-area specs (`PROJECTIONS_SPEC.md`, `LOG_FORMAT_SPEC.md`, `LAUNCH_DIALECT_READINESS.md`, `EXPERIMENT_DESIGN.md`).

This is the full remaining scope to ship the **first final version (v1.0)**: a signed, publicly releasable, passive EverQuest Legends session tracker + research command center. It is organized as milestones → epics → tasks, each with an acceptance note, dependencies, and an **[OWNER]** tag where a decision or hands-on action from LoFiGamerGuy is required. `[dev]` tasks the agent fleet can execute autonomously through the standard pipeline (spec → build → Claude review → Codex cross-review → human merge).

---

## Definition of v1.0 (scope line)

**In v1.0:** everything an individual player needs to passively track and analyze their own play with confidence — live tracker with overlay, trustworthy combat/heal/XP/loot analytics with evidence-based pet attribution, the core research comparisons (stance × invocation, weapon/AA A/B, route/leveling), customizable dashboards, privacy-safe export, user-confirmed evidence catalogs, and a signed Windows release running against the **launch** log dialect.

**Deferred to v1.1+ (explicitly out of v1.0):** multi-character/roster aggregation, cloud sync, mobile, cross-player leaderboards, plugin/trigger SDK (GINA-import), macOS hardening, AI-assisted analysis if it requires any network call (see D4). These are noted where relevant but do not block v1.0.

**v1.0 is done when:** the Definition-of-Done checklist (§Release) passes on the launch dialect, against real logs, with a signed artifact.

---

## Status snapshot

- **M0 (foundation) — DONE.** Governance, compliance boundary, architecture/data-model/specs, CI, prior-art.
- **M1 (parser + data spine) — DONE & MERGED.** event-schema · log-parser (113 recognizers + evidence-based entity/pet resolver) · log-tailer (resumable) · database (migrations, transactional watermark, idempotent) · orchestrator (durable pipeline) · analytics (projection writers + read API). Deterministic, resumable, incremental==rebuild, launch-dialect-ready. All cross-family reviewed.
- **Remaining to v1.0:** M1.5 hardening → M2 desktop tracker → M3 research command center → Launch-dialect authoring → Release engineering. Detailed below.

---

## M1.5 — Hardening & validation (bridge; do before/with M2)

Small, high-leverage items that de-risk everything built on the spine.

- **E1.1 [dev] Golden end-to-end corpus test (issue #21).** Replay the real ~434k-line beta corpus through tailer→parser→resolver→database→projections; assert idempotent ingestion, byte-offset resume, attribution, projection consistency, per-dialect unmatched < 2%. *This is also the real-world validation of the encounter-attribution logic that drew review majors twice.* **Dep:** the private corpus (local). **Accept:** suite green on the real corpus; unmatched rate reported. **[OWNER]** provide/keep the corpus available on the connected machine; confirm it's OK to run locally (fixtures stay anonymized, corpus never committed).
- **E1.2 [dev] `resolver_snapshot` → numbered migration.** Fold the orchestrator's interim `CREATE TABLE IF NOT EXISTS` into a real numbered migration in `packages/database`. **Accept:** migration 0002 in the central registry; migrate tests updated; orchestrator uses it. Housekeeping debt from #19.
- **E1.3 [dev] Parser throughput/perf pass.** Confirm the pipeline sustains raid-rate line volume without backpressure stalls; add a perf smoke test. **Accept:** documented lines/sec headroom; no watermark stall under a synthetic raid burst.
- **E1.4 [dev+OWNER] Close remaining UNVERIFIED log families.** Some families are schema-reserved pending a real sample: skill-ups, AA-xp gain lines, negative-faction caps, difficulty-tier marker, coin-loot (non-auto-sell) forms, charm-break lines (`RESEARCH_BACKLOG.md`). **[OWNER]** capture these in-game and hand over anonymized samples; **[dev]** add recognizer + fixture + test per confirmed sample. **Accept:** each newly-verified family has a fixture+golden; `RESEARCH_BACKLOG` updated. (Several of these are better captured on the **launch** client — see M-Launch.)

---

## M2 — Desktop session tracker (the app users run)

Turns the read API into a live, thin desktop app. **Architecture rule:** the UI is thin and consumes a typed **session-service API** (the seam) — no business logic in the UI (planning review #18).

### Epic 2A — Service seam & shell
- **E2.1 [dev] Thin session service API (issue #23).** A stable local API over the analytics read layer + orchestrator live mode: current session state, live encounter/actor stats, errors/status, analytics summaries. This is the Tauri IPC control point. **Dep:** M1. **Accept:** typed API with contract tests; the UI never imports parser/db internals.
- **E2.2 [dev] Tauri 2 + React + TS shell scaffold.** App skeleton under `apps/desktop`; Rust confined to filesystem/tailer/IPC glue; wires E2.1 over IPC. **Accept:** app boots, calls the service, renders a stub. **[OWNER]** confirm target OS scope for v1.0 = **Windows only** (macOS deferred) — recommended.

### Epic 2B — Live tracking
- **E2.3 [dev] Character auto-detection.** Watch the Logs dir; detect active `eqlog_<Char>_<server>.txt`; offer session start. **Accept:** newly-written log auto-detected; correct character/server.
- **E2.4 [dev] Session controls + live loop.** Start/stop/auto session; orchestrator live mode streams into the DB; UI updates live. **Accept:** numbers update as the log grows; clean stop/resume.
- **E2.5 [dev] Live dashboard.** DPS/HPS, encounter list with drill-down to raw lines, damage/healing breakdown (pet-fold toggle via `COALESCE(attrib_owner_id, entity_id)`), kills/deaths, XP/hr (active vs AFK), loot/coin. **Accept:** a played session's live numbers match a post-hoc replay of the same log (the determinism guarantee, surfaced).
- **E2.6 [dev] Compact always-on-top overlay mode.** A separate OS window (never injected/hooked/parented into the game — compliance). **Accept:** overlay shows live DPS/timer; toggles; stays on top; passes the compliance checklist.

### Epic 2C — Settings, export, polish
- **E2.7 [dev] Local settings** (log dir, thresholds like AFK gap, overlay prefs). Stored in app-data, never in the game dir.
- **E2.8 [dev] Privacy-safe export.** Character names pseudonymized by default, chat excluded unless opted-in per-export (`SECURITY_AND_PRIVACY.md`). **Accept:** export contains no raw other-player names by default.
- **E2.9 [dev] Design system pass.** Consistent, accessible dark/light UI (use the `dataviz` conventions for all charts). **[OWNER]** optional: a look/feel preference or brand direction; otherwise a clean neutral default.

**M2 done when:** a user installs it, plays, and sees a trustworthy live tracker + overlay whose totals reconcile with a replay, with export and settings.

---

## M3 — Research command center (the differentiator)

The analytics laboratory on top of the projections. Several of these are UI over read-API functions that already exist (`getExperimentBreakdown`, `getActorStats`, etc.).

### Epic 3A — Comparisons & experiments
- **E3.1 [dev] Stance × invocation comparison** (UI over the experiment breakdown; honest n + CI; refuse below min-n).
- **E3.2 [dev] Weapon & AA A/B experiments** (before/after and paired designs per `EXPERIMENT_DESIGN.md`).
- **E3.3 [dev] Class-trio timelines & leveling-race / build comparisons.** **Dep:** class-trio is **UNVERIFIED** in-log → user-entered until observed (E1.4 / catalogs). **[OWNER]** provide trio labels for your own characters.
- **E3.4 [dev] Route analysis** (XP/coin per camp/route; zone + difficulty segmentation). **Dep:** difficulty-tier source (E1.4) — until confirmed, tier is user-tagged.

### Epic 3B — Customization & evidence
- **E3.5 [dev] Customizable dashboards** (user-arranged panels over the read API).
- **E3.6 [dev] Screenshot evidence inbox.** Process user-supplied screenshots; attach to entities/items with provenance + confidence. **[OWNER]** supply representative screenshots to design against.
- **E3.7 [dev+OWNER] User-confirmed evidence catalogs** (AA / spell / item / ability) with provenance (direct/inferred/uncertain) + confidence, seeded from `Help/*.html` client docs (already inventoried) and corrected by the user. **[OWNER]** confirm/curate entries — the catalogs are explicitly *user-confirmed*, not auto-authoritative.

### Epic 3C — AI-assisted analysis (scope-gated)
- **E3.8 [dev+OWNER] AI-assisted analysis grounded in local data.** Natural-language questions answered from the normalized local DB. **[OWNER DECISION D4 required before build:** local-only model vs. an external API call, and the privacy stance — nothing leaves the machine without an explicit, previewed user action per `SECURITY_AND_PRIVACY.md`. If external, which provider.] May be deferred to v1.1 if it adds release risk.

---

## M-Launch — Launch dialect authoring (time-boxed, starts 2026-07-28)

The machinery (detection, drift report, per-dialect benchmark, playbook) is already merged (#22). This is executing the playbook on real launch logs.

- **EL.1 [auto/scheduled] Launch-day audit.** Scheduled task (2026-07-28 14:00 UTC) re-diffs ToS/EULA and, if the machine is connected, re-inventories the install + samples launch logs.
- **EL.2 [dev+OWNER] Author `eql-launch-2026-07` dialect.** Run `detectDialect`/`driftReport` on the first real launch logs; for each drifted family capture → anonymize → fixture → recognizer under the launch dialect (reuse unchanged rules). **[OWNER]** play the launch client and provide logs; **[dev]** author rules + fixtures; dual-family review. **Accept:** launch benchmark < 2% unmatched; detector routes launch logs to the launch dialect.
- **EL.3 [dev] Refresh the drift baseline** from the measured launch corpus (per the readiness plan's launch-day note).
- **EL.4 [OWNER] Compliance re-verify at launch.** Human-verify the ToS/EULA clause citations against the live pages; confirm nothing changed the passive-parser posture. Blocks public release.

---

## Release engineering & compliance (gates for "final")

- **ER.1 [dev+OWNER] Signed Windows release.** Release workflow builds a signed installer at tagged versions. **[OWNER DECISION D2:** obtain a code-signing certificate (cost + procurement + secure storage of the signing key as CI secrets). Unsigned builds are the fallback but flag SmartScreen warnings.]
- **ER.2 [dev] Auto-update + semver + release notes** on tagged releases.
- **ER.3 [OWNER DECISION D3] Distribution channel** — GitHub Releases / a website / RedGuides / other. Affects the release + update workflow.
- **ER.4 [dev] Automated dependency updates** (Renovate/Dependabot) + the security CI already in place.
- **ER.5 [OWNER+dev] Final compliance pass & LICENSE finalize.** Confirm the shipped app contains only passive features (no memory/injection/packets/automation); no game-binary-derived data in the repo/release; `LICENSE` (MIT proposed) confirmed; README compliance statement. **[OWNER]** final sign-off (this is the passive-only guarantee the whole project rests on).
- **ER.6 [dev] User-facing docs** — README quickstart, a short user guide, CONTRIBUTING finalized.

---

## Dependency / sequencing view

```
M1 (done)
  ├─ M1.5 hardening ──┐
  │   E1.1 golden e2e ┼─► highest-confidence path: run FIRST (validates analytics before UI)
  │   E1.2/E1.3/E1.4  │
  ├─ M2 desktop  ◄────┘  (E2.1 service seam is the gate; E2.* build on it)
  │      └─► M3 research (UI over read API; needs M2 shell + service)
  ├─ M-Launch (starts 7/28; parallel; feeds real dialect + verifies families for M1.5/M3 catalogs)
  └─ Release eng (ER.*; ER.1/ER.3/ER.4 can start anytime; ER.4 gate = launch compliance + signing)
```

**Recommended order:** E1.1 (golden e2e) → E2.1 service seam → M2 tracker → core M3 (3A/3B) → launch-dialect authoring (as logs arrive) → release hardening → v1.0. Advanced M3 (3C AI) and any deferred items follow in v1.1.

---

## Resolved decisions (2026-07-23)

- **D1 — Sequencing: RESOLVED.** Golden e2e (E1.1) first, then M2. ✅
- **D2 — Code signing: DEFERRED.** Not needed for personal use (v1.0 is personal-first). A code-signing cert (~$100–400/yr from a CA) only matters to avoid Windows SmartScreen "unknown publisher" warnings *when distributing to others*. Release workflow is built cert-ready; signing turns on if/when D3 → public distribution happens.
- **D4 — AI architecture: RESOLVED (directive).** Build a **provider-agnostic AI layer**: a pluggable `AIProvider` abstraction with a registry of adapters (e.g. OpenAI, Anthropic, local/Ollama, others), **dynamic selection**, graceful degradation so it functions with **any single** provider configured, and per-capability routing (the user can prefer/route models per task). Local-only (Ollama) is a first-class option for full privacy; any external call is explicit and previewed per `SECURITY_AND_PRIVACY.md` (nothing leaves the machine silently). Analysis is always grounded in the normalized local DB. Ships in v1.0 if it doesn't add release risk, else v1.1.
- **D5 — OS scope: RESOLVED.** Windows-only for v1.0; macOS deferred. ✅
- **D6 — Repo visibility & license: OPEN (new, important).** The goal in D3 is *personal use now, and possibly sharing later only as a locked binary with no source access.* That conflicts with the **current state: a public GitHub repo under MIT — the full source is already open.** For personal use this changes nothing. But before any sharing, choose: **(a)** stay open-source (public + MIT) — strongest fit with the passive-parser precedent that underpins the compliance argument, source is auditable, but anyone can read/fork it; or **(b)** go **private repo + proprietary license + binary-only distribution** — matches "share the app, not the source," at the cost of the open/auditable posture. Switchable at any time (repo → private; add a proprietary `LICENSE`); cleaner to decide before inviting anyone. **No action needed while it's personal-only.**

## Testing & verification strategy (pre-launch vs post-launch)

The parser must never fabricate a format, so recognizers are only built from **real** samples. Coverage before the game's 2026-07-28 launch:

- **Primary: the owner's real beta corpus** (~434k lines, on the connected machine) — drives the golden e2e (E1.1) and stays private/local (never committed; only anonymized excerpts become fixtures).
- **Supplemental: public EQ-family sample logs** may be sourced to harden the parser against edge cases — kept **local-only and anonymized**, never committed, and treated as EQ-*family* (P99/EQ1 era), **not** EQL-exact; useful for robustness, not for defining the EQL dialect.
- **Visual QA via computer-use (within compliance):** the agent can drive the owner's desktop *observationally* — screenshot and verify the **desktop app's** UI as M2/M3 are built, and (post-launch) **correlate the game screen with parsed log lines / screenshots** (exactly the "correlate candidate records with screenshots, logs, and observed gameplay" the vision calls for). Hard line: **observation only — no automated keyboard/mouse input to the game, no gameplay automation** (compliance). Launching/observing the app is fine; playing or automating the game is not.
- **Post-launch:** the owner plays the launch client and provides logs + in-game confirmations for the launch dialect (EL.2) and the UNVERIFIED families (E1.4) — the parts that genuinely require a human at the keyboard.

## Decisions & inputs needed from you (LoFiGamerGuy)

These are the only things blocking full-speed autonomous execution. None are needed *today* except D1.

- **D1 — Sequencing (now):** confirm **E1.1 golden e2e first**, then M2 — vs. jumping straight to the M2 UI. *Recommend e2e-first.*
- **D2 — Code-signing certificate (before ER.1):** will you obtain one (and cover the cost)? Determines signed vs. unsigned v1.0.
- **D3 — Distribution channel (before ER.2/ER.3):** where does v1.0 ship (GitHub Releases / site / RedGuides)?
- **D4 — AI-assisted analysis (before E3.8):** local-only, or an external API? If external, which provider — and confirm the privacy posture. Or defer to v1.1.
- **D5 — Windows-only for v1.0?** (macOS deferred) — *recommend yes.*
- **Hands-on captures (as they come up):** in-game samples for the UNVERIFIED families (E1.4), launch logs post-7/28 (EL.2), representative screenshots (E3.6), and evidence-catalog curation (E3.7). These need you at the keyboard because the parser must never fabricate a format or guess mechanics.
- **Standing:** keep the cross-family (Codex) review in the loop per ADR-010 — assumed yes unless you say otherwise.

Everything tagged `[dev]` proceeds through the fleet without you. I'll surface a **[OWNER]** item only when I actually reach it and need the input/decision, so the work never blocks silently.

---

## Tracking

Each epic/task becomes a GitHub issue under the milestone it belongs to (M1.5 / M2 / M3 / M-Launch / Release). The planning review (#18) and its tickets (#19–#23) fold into this: #19/#20/#22 done; **#21 = E1.1**; **#23 = E2.1**. This doc is the source of truth for scope; the issue tracker is the source of truth for status.
