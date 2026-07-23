# Open Legal & Compliance Questions

Non-lawyer risk analysis. Last updated 2026-07-22. Companion to COMPLIANCE_BOUNDARIES.md.

## Q1. What exactly did the EQL beta NDA say, and does any of it survive?

**What we know:** Closed beta (from 2026-04-24) launched under a press-described "strict NDA" (Massively OP, 2026-04-10). The NDA was later lifted — "NDA Lifted" creator videos, public wikis, and public patch notes exist. The paid pre-order beta (July 1–21) had no evident NDA: access was sold openly and coverage was universal. Beta ended 2026-07-21; launch is 2026-07-28. Crucially, **we have never seen the NDA text** — Daybreak's "EverQuest Legends Beta" help article sits behind a login wall, and neither the public ToS nor EULA contains a beta confidentiality clause.

**Residual risk:** NDAs commonly contain survival clauses; information obtained during the NDA-covered window (pre-lift closed beta) could technically remain restricted even after the lift. "NDA lifted" announcements sometimes lift streaming/discussion but not datamined material.

**Default posture:** The owner should re-read the agreement actually clicked through (launcher/Discord) if he participated in the closed beta. Nothing derived specifically from pre-lift closed-beta data ships or is published. Data from the paid pre-order beta or launch (July 28+) is treated as unrestricted. Prefer regenerating all reference data against the launch client.

**RESOLVED 2026-07-23 (ADR-009):** The owner reviewed the beta agreement he actually accepted and confirmed it contains no surviving restrictions applicable to this project's beta-derived data. The "radioactive" caution on closed-beta-derived data is lifted; beta-corpus fixtures and reference data may be used and published under the standing anonymization and no-binary-derived-content rules. Regenerating reference data against the launch client remains good practice (the wipe and expected dialect changes make it necessary anyway), but is no longer a compliance requirement.

## Q2. Do printable-string scans of game binaries breach the no-reverse-engineering clause?

**What we know:** EULA §4.2 prohibits attempts to "reduce the Software … to a human-readable form or … discover any source code, underlying ideas, algorithms, file formats or programming interfaces." A strings scan performs no reduction — it prints bytes already human-readable — and discovers no source code or algorithms. DMCA §1201 is not implicated: nothing is circumvented. Realistic exposure is contract-based (account action), not statutory.

**Residual risk:** A maximalist reading of "underlying ideas" could stretch to cover strings inspection. Courts have not settled how far such clauses reach for pure inspection of lawfully installed files; enforceability varies by jurisdiction (the EULA itself concedes exceptions where applicable law forbids such restrictions).

**Default posture:** Permitted on the owner's machine only; results local-only, never published, never used to interoperate with or modify the running game. Risk: YELLOW.

## Q3. Is imports/exports (PE header) inspection meaningfully riskier than strings?

**What we know:** Import/export tables are standard PE structures readable by ubiquitous benign tools (dumpbin, Dependency Walker, AV engines). Nearest clause hook: §4.2 "programming interfaces". No disassembly involved.

**Residual risk:** Slightly higher than strings only because import analysis is a classic first step of actual reverse engineering; intent matters optically. Same contract-only exposure.

**Default posture:** Allowed, local-only, inventory purposes only. Never publish import maps. Risk: YELLOW.

## Q4. Archive metadata for proprietary pack files — where is the line?

**What we know:** EULA §4.2 names "file formats" explicitly. Reading sizes/hashes/plaintext headers requires no format knowledge; writing a structural parser for a proprietary container IS file-format discovery.

**Default posture:** Size/hash/visible-plaintext only. No structural parsing, no unpacking, no decryption ever (decryption also crosses into DMCA §1201 territory). Risk: YELLOW at the boundary, RED past it. Category F–H files (see EQL_FILE_CLASSIFICATION.md) stop at metadata + a research note + human approval.

## Q5. Is publishing our parser publicly safe now that beta ended / at launch?

**What we know:** ToS §7.1 bars "develop, share, or use" of gameplay-modifying or advantage-granting software — publishing carries the same characterization risk as running it. Franchise precedent is strongly favorable: GamParse, GINA, EQLogParser, and ACT have been public for 15–25 years with no known Daybreak action against passive log parsers; logging is an intentional, player-facing feature; EQL-specific public parsers (EQL Meter — open-source, EQL Tools, a public ACT plugin thread) exist unactioned. Daybreak's actual enforcement line has always been process/packet intrusion (ShowEQ, MacroQuest), not log reading.

**Residual risk:** No official Daybreak statement blessing parsers for EQL was found; §7.1's "any kind of advantage" is broad enough to cover a DPS meter if Daybreak ever chose to enforce it; ToS was updated 2026-07-13 and could change again at launch.

**Default posture:** Publish at/after launch (2026-07-28). Ship ONLY the passive log/screenshot/config features — the binary-inventory tooling stays a private, unpublished script for the owner. Include a README compliance statement (passive-only; no memory/injection/packets/automation). Re-diff the ToS/EULA at launch. Risk: GREEN with these constraints.

## Q6. Does Daybreak's EULA §5 monitoring ("Unauthorized Third Party Program") affect us?

**What we know:** The EULA defines detection-and-telemetry rights over programs that enable cheating, modify the game interface, or intercept client-server data. A separate-process, read-only file consumer does none of these.

**Residual risk:** "Modify the game interface" could in theory be read against overlays. Ours is a separate OS window, not injected into the game's UI.

**Default posture:** Hard architectural rule (COMPLIANCE_BOUNDARIES.md): no handle to the game process beyond what the OS grants any unprivileged file reader; overlay never parented to or hooked into the game window. Risk: GREEN.

## Q7. ToS churn

The ToS was updated 2026-07-13, two weeks before launch. Diff ToS + EULA on launch day and quarterly thereafter; clause numbers cited in COMPLIANCE_BOUNDARIES.md must be re-verified after each update.

## Red flags register

1. ~~**The EQL beta agreement text is unobtainable publicly** — the single biggest unknown.~~ **RESOLVED 2026-07-23:** owner reviewed the agreement he accepted; no surviving restrictions apply (ADR-009). Launch-client regeneration remains recommended practice only.
2. **ToS §7.1 is broad enough to prohibit a DPS parser if Daybreak ever wanted to** ("any kind of advantage … except as expressly authorized"). Tolerance is customary, not contractual. Acknowledged in README; immediate compliance with any takedown request.
3. **EULA §4.2 explicitly lists "file formats" as a prohibited discovery target.** Inventory tooling stays at hash/size/plaintext-header level — no container parser, ever.
4. **No official Daybreak statement on parsers for EQ Legends found** — favorable precedent is behavioral, not contractual, and could change at launch. Re-check official forums/Discord at launch.
5. **ToS updated 2026-07-13** — machine-extracted quotes must be human-verified before docs ship; launch-day re-diff mandatory.

## Key sources

- https://www.daybreakgames.com/terms-of-service — ToS (Last Updated July 13, 2026): §7.1 third-party software & no-disassembly, §10 cheating, §12 IP ownership, §13 restrictions; no beta-NDA clause found.
- https://www.daybreakgames.com/eula?locale=en_US — EULA: §2 license, §4.2 reverse engineering/"file formats", §4.5 data mining/decryption of transmitted data, §4.6 bots/macros, §5 Unauthorized Third Party Program monitoring; no beta-NDA clause found.
- https://www.daybreakgames.com/conduct-policy?locale=en_US — Conduct Policy (secondary).
- https://massivelyop.com/2026/04/10/everquest-legends-officially-enters-a-strict-nda-closed-beta-on-april-24/ — "strict NDA" closed beta from 2026-04-24.
- https://massivelyop.com/2026/07/01/everquest-legends-begins-paid-beta-for-preorder-folks-this-afternoon-lets-gooooo/ — paid beta July 1; launch July 28.
- https://www.everquestlegends.com/news/everquest-legends-preorder — official: beta July 1–21, wipe at beta end, launch July 28, 2026.
- https://help.daybreakgames.com/hc/en-us/articles/52413008844307-EverQuest-Legends-Pre-Order-and-Beta — official help stub; the deeper "EverQuest Legends Beta" article (51081724830611) redirects to login — beta agreement text not publicly accessible.
- https://forums.advancedcombattracker.com/discussion/467/eq1-eqlegends — ACT plugin dev confirms EQL writes EQ1-style disk logs.
- https://eqlmeter.com/ — public, open-source (MIT) EQL log parser + overlay; unactioned as of 2026-07-22.
- https://eqltools.com/log-parser — second public EQL log parser.
- https://www.showeq.net/forums/archive/index.php/t-2371.html — ShowEQ history: the historical enforcement line.
