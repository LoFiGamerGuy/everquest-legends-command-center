# EQL Installation Audit — Stage 0

**Scope & authority:** Owner-authorized comprehensive READ-ONLY inspection (docs/DECISION_LOG.md ADR-001) of the owner's own installation at `C:\Users\Public\Daybreak Game Company\Installed Games\EverQuest Legends`. Build phase: pre-launch beta client (beta ended 2026-07-21; launch 2026-07-28 — expect a launch re-audit). Hard rules honored: nothing written to or executed from the install; no decryption, unpacking, or structural parsing of proprietary formats; results local-only (`data/` is gitignored, never published).

## Headline inventory (enumeration pass, 2026-07-22)

- **12,617 files / 60 directories / 6.89 GB** (manifest: `data/manifests/eql-beta-installation.{json,sqlite}`)
- Top directories by file count: `sounds` 3,029 · root 2,901 · `uifiles` 2,568 · `maps` 1,830 · `Resources` 718 · `SpellEffects` 531 · `Textures` 258 · `RenderEffects` 203 · `Help` 180 · `LaunchPad.libs` 179
- Dominant formats: `.eqg` 1,059 + `.s3d` 453 (proprietary archives, 4.28 GB — category F, metadata-only) · `.txt` ~2,000+ readable · `.tga/.dds` UI art · `.mp3/.xmi` audio
- **3,445 readable plaintext files** (A/B/C categories) — see `data/reports/readable-text-candidates.csv`
- **677 name-flagged game-data candidates** — see `data/reports/game-data-candidates.csv`
- Reports: `file-extension-summary.csv`, `largest-files.csv`, `duplicate-files.csv` (size-based candidates; hash confirmation pending)

## Provenance notes (direct observations)

- Layout is classic EverQuest-derived: `eqclient.ini`, `.eqg/.s3d` zone archives, per-character UI layout INIs (`<Char>_<zone>_LO1.ini`), `Logs/` with `eqlog_<Char>_<server>.txt`. EQL-specific config: `eqlsClient.ini`, `eqlsPlayerData.ini`, `eqlsUIConfig.ini`.
- Legacy EQ1 boilerplate ships in the install (e.g., `loghelp.txt` still references verant.com-era support emails) — direct evidence the client reuses EQ1-lineage assets; do not assume any given file reflects current EQL mechanics without correlation.
- `Logs/` contained 10 character logs (~30 MB, 434k lines) at audit time — the parser ground-truth corpus (kept private; fixtures are anonymized excerpts only).
- `Help/` contains per-topic HTML (`aas.html`, `achievements.html`, `chatchannels.html`, …) — category C, high-value readable documentation.

## Pass status

| Pass | Status |
|---|---|
| Recursive enumeration (path/size/type/mtime) | ✅ complete 2026-07-22 |
| Classification A–H | ✅ complete (see EQL_FILE_CLASSIFICATION.md) |
| Manifest JSON + SQLite | ✅ complete |
| Extension/largest/duplicates(size) reports | ✅ complete |
| Hashing (SHA-256) | ✅ complete 2026-07-23 — 12,745 files hashed natively (resumable slices); full hash list kept owner-side |
| Duplicate confirmation by hash | ✅ complete 2026-07-23 — 730 duplicate groups, 1,017 redundant copies, ~145 MB (mostly music/UI assets shipped twice) |
| Plaintext keyword sweep (`scripts/search-readable-resources.py`) | ⏳ scheduled — run against the 3,445 A/B/C files |
| PE metadata pass (version/signature/imports — D files, 29) | ⏳ scheduled (local-only; COMPLIANCE #8–9) |
| Archive metadata (E/F — identification only, no structural parsing) | ⏳ research notes only (COMPLIANCE #11) |
| Beta-vs-launch manifest diff | ⏸ after 2026-07-28 launch re-inventory |

## Non-findings / stops honored

No decryption keys sought, no formats probed, no executables run, no memory touched. Category F (2,431 files) and H (382) recorded as metadata + hashes only, with research notes in STATIC_DATA_DISCOVERY.md; anything deeper requires explicit owner approval per policy.
