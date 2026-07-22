# EQL File Classification (Discovery Categories A–H)

Classifier: `scripts/classify-eql-files.py` (extension/name rules, v1). Per-file assignments live in the sqlite manifest (`files.category`). Counts from the 2026-07-22 enumeration:

| Cat | Definition | Count | Bytes | Inspection policy |
|---|---|---|---|---|
| A | Directly readable user-generated data (eqlog_*, dbg.txt, per-character UI/layout INIs, _characters.ini) | 32 | 34.2 MB | Read freely (owner's own data); anonymize before anything public |
| B | Readable game configuration/structured data (.ini/.cfg/.json/.csv) | 37 | 0.98 MB | Read-only inspection OK |
| C | Readable localization/UI/resource & media metadata (.txt/.xml/.html; media files counted here for triage) | 9,683 | 2.25 GB | Text: read-only OK. Media: metadata only |
| D | Executables/libraries (.exe/.dll/.asi) | 29 | 208.6 MB | Metadata only: version info, signatures, hashes, imports/exports (local-only; never executed, never disassembled) |
| E | Standard archives/containers (.pak/.zip) | 23 | 30.2 MB | Standard metadata/listings only if accessible without circumvention |
| F | Undocumented binary / proprietary containers (.eqg/.s3d/.eff/.zon/.emt/.xmi/.m3d/.edd/.eal/.dat) | 2,431 | 4.28 GB | Hash + size + plainly visible header text ONLY. **No structural parsing — EULA §4.2 "file formats" (COMPLIANCE #11). Stop + research note + owner approval before anything more** |
| G | Encrypted/obfuscated/protected | 0 identified yet | — | Identification only; never bypassed |
| H | Unknown | 382 | 75.1 MB | Triage by extension/name; promote to A–F when identified, else metadata-only |

Known caveats (v1 classifier): media files are lumped into C for triage convenience — they are *assets*, not text; split into a media category in v2. `.pak` here may be a proprietary variant rather than standard — verify via non-circumventing identification (file magic via `file`) before treating as E. `.txt` under `Resources/` may include machine-generated asset lists rather than human documentation.

Re-run: `python3 scripts/classify-eql-files.py manifest.tsv > classified.tsv`.
