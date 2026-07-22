# EQL Command Center

Local-first, open-source session tracker, combat-log parser, analytics laboratory, and customizable player command center for **EverQuest Legends**.

**Strictly passive.** EQL Command Center reads the log files the game writes to your own disk — after the game writes them — and nothing else. It never reads game memory, injects code, hooks rendering, sniffs packets, automates input, or modifies the game in any way. See [docs/COMPLIANCE_BOUNDARIES.md](docs/COMPLIANCE_BOUNDARIES.md).

## What it does (roadmap)

Live session tracking · combat-aware DPS · pet & charm attribution · healing analysis · kills & deaths · XP and AA rates · loot, coin, auto-sell and drop statistics · skill-ups & faction changes · zone/difficulty/stance/invocation timelines · leveling-race and build comparisons · weapon/stance/AA A/B experiments · route analysis · customizable dashboards · compact always-on-top mode · user-confirmed evidence catalogs · privacy-safe exports · AI-assisted analysis grounded in your own local data.

## Principles

- **Local-first.** Your data stays on your machine. No cloud account. Exports are explicit and privacy-safe.
- **Evidence over guesses.** Every parser rule is backed by a real (anonymized) log fixture. Attribution carries evidence and confidence, never silent guesses. Unmatched lines are retained and measured, not dropped.
- **Deterministic parser core** (TypeScript, UI-independent) → typed append-only events → SQLite projections → analytics → UI. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **Compliance is a hard boundary, not a preference.** Daybreak's ToS and EULA are treated as constraints; we comply immediately with any request from Daybreak. This project is not affiliated with or endorsed by Daybreak Game Company.

## Status

Pre-alpha: Stage 0 (discovery, governance, format research) complete; M1 parser core in progress. Not yet usable.

## Stack

Tauri 2 · React · TypeScript · SQLite · narrowly-scoped Rust (file tailing only).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — note the fixture policy (anonymized logs only) and compliance gate. All merges require human review.

## License

MIT — see [LICENSE](LICENSE).
