# Compliance Boundaries

**This document gates all feature work. No feature ships that violates it. Expanding any boundary requires explicit human (project owner) approval recorded in docs/DECISION_LOG.md.**

Last research pass: 2026-07-22. Governing documents: Daybreak Terms of Service (https://www.daybreakgames.com/terms-of-service, "Last Updated: July 13, 2026") and Daybreak EULA (https://www.daybreakgames.com/eula). Clause quotes were machine-extracted on 2026-07-22 and must be human re-verified before any public release; a launch-day (2026-07-28) ToS/EULA re-diff is mandatory. This is risk analysis by non-lawyers, not legal advice.

## Project posture

EQL Command Center is **passive and informational**. It reads files the game writes to the player's own disk, after the game writes them. It never touches the game process, network traffic, or input stream, and never modifies the game installation.

## Capability matrix

| # | Capability | Status | Governing clause | Risk | Notes |
|---|-----------|--------|------------------|------|-------|
| 1 | Read game-written chat/combat log files (player-enabled logging) | **ALLOWED — core feature** | No clause prohibits reading logs the game writes for the player. ToS §7.1 bars software that "modifies the game play in any way or that gives a user any kind of advantage over other end users, except as expressly authorized" — passive after-the-fact log reading modifies nothing. | GREEN | 25+ years of precedent: GamParse, GINA, EQLogParser (EQ1), ACT (EQ2) operated openly with no known bans or C&Ds; logging is a built-in game feature. EQL already has public parsers (EQL Meter, EQL Tools) and an ACT plugin in development. |
| 2 | Live log tailing with out-of-game overlay (DPS/heals/timers) | **ALLOWED, with design care** | Same ToS §7.1 "advantage" language is the only hook. | GREEN/YELLOW | Overlay is a separate OS window; never drawn into, parented to, or hooked into the game's renderer or window; never feeds input back. |
| 3 | Read benign local config files (plaintext INI/settings) | ALLOWED | No clause found. | GREEN | Read-only. We never write game configs. |
| 4 | Observe file metadata (paths, sizes, mtimes, create/append events) | ALLOWED | No clause found. | GREEN | — |
| 5 | Process user-supplied screenshots | ALLOWED | No clause found; player-created content. | GREEN | Local processing only; mass republication of captured game assets is a separate IP question (ToS §12). |
| 6 | Store user-entered data | ALLOWED | No clause found. | GREEN | — |
| 7 | Hash installed game files (owner's own install, local-only) | ALLOWED (inventory scope) | Not reverse engineering under EULA §4.2; no clause found on hashing. | GREEN | Local-only, never redistributed. |
| 8 | Read PE metadata: version info, digital signatures | ALLOWED (inventory scope) | Standard OS-level metadata (what Explorer/`sigcheck` shows). Not "disassembly" (ToS §7.1 / EULA §4.2). | GREEN | Local-only. |
| 9 | Enumerate PE imports/exports | ALLOWED (inventory scope), **local-only** | Brushes EULA §4.2's ban on discovering "programming interfaces". Import tables are public PE-header structure, not source code. | YELLOW | Never published; never used to build hooks/injectors (we never do). |
| 10 | Printable-strings scan of binaries | ALLOWED (inventory scope), **local-only** | Gray under EULA §4.2 ("reduce the Software … to a human-readable form"). Counter-reading: `strings` reduces nothing — bytes are displayed verbatim; no decompilation/translation/decryption. DMCA §1201 not implicated (nothing circumvented). | YELLOW | Contract-breach risk (account action), not statutory. Results stay local; string dumps are never redistributed (also a ToS §12 IP issue). |
| 11 | Archive/container metadata of proprietary pack files (no decryption, no unpacking) | **GRAY — size/hash/plainly-visible header text only** | EULA §4.2 explicitly lists discovering "file formats" among prohibited aims. | YELLOW/RED | No structural parser for proprietary containers, ever. If format understanding would require trial-and-error structural analysis: STOP — that is format discovery. |
| 12 | Decrypt or unpack proprietary/encrypted formats | **FORBIDDEN** | EULA §4.5 (decryption of transmitted data), §4.2 (file formats); DMCA §1201 the moment a protection measure is bypassed. | RED | Never. This is our DMCA bright line. |
| 13 | Decompile / disassemble game code | **FORBIDDEN** | ToS §7.1: "You may not disassemble, reverse engineer, or modify any Daybreak Game(s) software in any way." EULA §4.2. | RED | Never. |
| 14 | Read process memory / DLL injection / render hooking | **FORBIDDEN** | ToS §7.1; EULA §5 ("Unauthorized Third Party Program" detection & telemetry). Precedent: ShowEQ and MacroQuest are what Daybreak has fought and banned for. | RED | Never. We take no handle to the game process beyond what the OS grants any unprivileged file reader. |
| 15 | Packet sniffing / protocol analysis | **FORBIDDEN** | EULA §4.5 ("mine, decrypt, or modify any data transmitted between any client and server"); §4.3. ShowEQ is the canonical banned-tool precedent. | RED | Never. |
| 16 | Automate input / unattended play / botting | **FORBIDDEN** | EULA §4.6 (bars "cheats, hacks, mods, macros, 'bots' or other programs which would allow unattended game play"); ToS §10. | RED | Never. No targeting, movement, casting, looting, or combat automation of any kind. |
| 17 | Modify game executables or client assets | **FORBIDDEN** | ToS §7.1; EULA §4.2. | RED | The tool never writes inside the game directory. Backups live outside it. |
| 18 | Publish the parser publicly | **ALLOWED post-launch (2026-07-28)** | ToS §7.1 "develop, share, or use" — publication risk equals the tool's own risk (green for passive log parsing). Public precedent exists for EQL specifically (EQL Meter is open source and unactioned). | GREEN | See LEGAL_AND_COMPLIANCE_QUESTIONS.md Q1/Q5 re: closed-beta-derived data. |
| 19 | Redistribute extracted game data (string dumps, asset lists, binary-derived tables) | **FORBIDDEN** | ToS §12: "Daybreak and its licensors own all right, title and interest in and to the Daybreak Games." | RED | `data/` is gitignored; binary-derived material never leaves the owner's machine. Community-wiki-style gameplay facts (user-observed) are different in kind and handled under the evidence-catalog provenance rules. |

## Hard architectural rules derived from this matrix

1. The application opens game files read-only and never holds a handle to the game process.
2. The overlay is a plain OS window — never injected, hooked, or parented to the game window.
3. Nothing in the public repository or any release artifact contains data derived from game binaries or proprietary containers (see `.gitignore`: `data/` is excluded at the root).
4. The binary-inventory tooling (`scripts/inventory-*`, `hash-*`, `search-readable-resources.py`) is research tooling for the owner's private use; it is not part of the shipped application and its outputs are never published.
5. Any takedown or cease-and-desist request from Daybreak is complied with immediately and fully.

## Re-verification schedule

- Human verification of all quoted clause text against live pages: **before first public release**.
- ToS/EULA re-diff: **launch day 2026-07-28**, then quarterly.
- Any ToS/EULA update invalidates clause citations here until re-verified.
