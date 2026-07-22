# Static Data Discovery — Research Notes

Goal: locate READABLE files that may corroborate AA/spell/skill/item/zone/UI/command/log-template facts. **Nothing here is authoritative game-mechanics data** — every candidate must be correlated with logs, screenshots, and observed gameplay before entering an evidence catalog (provenance: direct/inferred/uncertain).

## High-value readable candidates (from name-based triage, 2026-07-22)

| Area | Where | Notes |
|---|---|---|
| Help topics incl. AAs | `Help/*.html` (180 files: aas.html, achievements.html, augments.html, bazaar.html, chatchannels.html, …) | Official player-facing docs shipped with the client — best-quality readable source; still verify currency (legacy EQ1 text ships in this install) |
| UI definitions/labels | `uifiles/default*` (2,568 files; default, default_light, default_modern skins) | EQ-lineage UI is XML-driven; label/command strings likely readable — top target for the keyword sweep |
| Zone identifiers | `maps/` (1,830 files), `*.zon`, `*_chr.txt`, `*_assets.txt`, `*_EnvironmentEmitters.txt` | Map/asset lists give zone short-names ↔ display names |
| Audio triggers | `AudioTriggers/{default,shared}` | Classic EQ audio-trigger lists are plaintext phrase lists — may double as log-message-template evidence |
| Log-message templates | `loghelp.txt` (legacy), `Help/chatchannels.html`, AudioTriggers | Correlate with LOG_FORMAT_SPEC.md; the log corpus itself remains primary evidence |
| Character/account config | `eqlsPlayerData.ini`, `_characters.ini`, `<Char>_<zone>_LO1.ini` | Category A/B; useful for character auto-detection design (M2) |
| Spell/stance/invocation strings | TBD — keyword sweep pending | If EQL follows EQ1, a spell-name resource may exist in readable or F-category form; only readable sources are usable |

## Category F/G research notes (metadata-only; STOPPED per policy)

- `.eqg`/`.s3d` (4.28 GB): EQ-lineage zone/model archives. Community documentation of these formats exists publicly for EQ1, but **structural parsing is squarely inside EULA §4.2 "file formats" — out of scope without explicit owner approval and a documented legal reassessment** (LEGAL_AND_COMPLIANCE_QUESTIONS.md Q4). Potential value if ever approved: zone/model name tables. Current stance: hash + size only.
- `.pak` (19): identify magic bytes non-circumventingly (`file`); if standard zip-compatible, listing may be permissible (COMPLIANCE #11); if proprietary variant, treat as F.
- `.xmi` (30): standard-ish MIDI container lineage; audio only, low research value.
- `.eff/.zon/.emt/.edd/.eal`: effect/zone metadata blobs; hash-only.

## Next actions (owner-approved scope, local-only)

1. Run `scripts/search-readable-resources.py` over the 3,445 A/B/C plaintext files → `data/reports/` keyword hits (AA, spell/song, class/race, skill, item, zone/NPC, UI/command, log-template, pet terms).
2. Read `Help/aas.html` + siblings; extract candidate AA terminology → evidence catalog (provenance: "client Help file, beta build, uncorroborated").
3. `file`-identify `.pak` magic; PE metadata pass over the 29 D-category binaries.
4. Post-launch (≥2026-07-28): re-inventory, diff manifests, regenerate all reference data from the launch client (beta NDA caution, LEGAL Q1).
