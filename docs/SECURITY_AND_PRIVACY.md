# Security & Privacy

## Data locality
All data stays on the user's machine: SQLite DB + settings in the OS app-data directory (never inside the game directory). No cloud account, no telemetry, no network calls except: (a) user-initiated update checks/downloads, (b) optional user-initiated imports of public documentation. Backups are written outside the game directory.

## What we collect from logs
Player-visible log text only. Logs contain other players' character names and chat — treat as sensitive:
- **Exports are privacy-safe by default**: character names pseudonymized, chat excluded unless the user explicitly opts in per-export.
- **Public fixtures are always anonymized** (CONTRIBUTING.md policy; enforced by scripts/validate-fixtures.ts).
- AI-assisted analysis operates on normalized local data; nothing is sent anywhere without an explicit user action and a visible preview of what would be sent.

## Game installation
Read-only, always. The app never writes to, and never executes anything from, the game directory. Research inventory tooling (scripts/) is owner-run, local-only; its outputs live under data/ which is gitignored and never published.

## Supply chain
Dependencies pinned via lockfiles; automated dependency updates via PRs (human-merged); CI runs npm audit + secret scanning (gitleaks) on every PR. Release artifacts built in CI from tagged commits; Windows code signing when a certificate is provisioned (docs/ROADMAP.md).

## Threat model notes
The app parses attacker-controllable text (other players' chat appears in logs). Parser rules must never eval or interpolate log content into queries (parameterized SQL only), and the UI must render log-derived strings as text, never HTML.
