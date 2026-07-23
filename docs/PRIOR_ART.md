# Prior Art Review

Research pass: 2026-07-22 (web + source-level inspection of the two clonable repos). Rule: we do not copy source code unless its license clearly permits it and the use is documented here and in NOTICE; we prefer independent implementation from documented behavior.

## EQBuddy — NOT FOUND

No public repository, website, or forum presence for an EverQuest/EQL tool named "EQBuddy" was findable (GitHub, GitLab, SourceForge, Codeberg, Reddit, Steam, RedGuides, eqlwiki searched 2026-07-22; the only hits are an unrelated AI-recruitment product). It may be Discord-only, private, renamed, or misremembered. **Do not cite it as prior art until someone produces a link.** Closest real equivalent: EQL Meter (below).

## EQL Meter (`kpxcoolx/eql-meter`) — closest direct competitor, source-verified

- **Stack:** Tauri 2 + React 19 + TypeScript (Vite) frontend; Rust backend (`regex 1.13`, `notify 8.2`). Same stack we planned — the reference implementation to study. v0.1.25 released 2026-07-15; actively developed.
- **Architecture (verified from source):** byte-offset tailing (`seek(SeekFrom::Start(offset))`, read to EOF); truncation/rotation detection `if len < offset { offset = 0 }`; `notify` fs events **plus unconditional 150 ms polling** ("events alone are not enough" on virtual disks); per-event-family regex modules (`damage.rs`, `heal.rs`, `avoid.rs`, `stance.rs`, `who.rs`) with named capture groups and inline unit tests; character/server derived from `eqlog_<Char>_<server>.txt` filename; fight keyed by mob name, opened only by YOU or your pet, closed on death or 10 s idle, `ended_at` back-dated to last hit; heuristic session-only `pet_owners` map.
- **Strengths:** proven EQL regexes; robust tail loop; real sample beta logs committed for tests; changelog discipline.
- **Limitations (our opportunities):** no persistence at all (no history across sessions); no XP/loot/session analytics; solo-perspective fight opening loses group encounters; pet map resets every session; offsets not resumable across restarts.
- **License: MIT** (confirmed LICENSE.md). We may reuse code and their sample logs with copyright notice retained.
- **Reproduce:** poll+notify hybrid; truncation check; per-family regex modules with fixtures; encounter-end back-dating. **Improve:** durable SQLite event store; group-wide encounters; persistent evidence-based pet registry; XP/loot/economy; resumable offsets.

## EQL Tools log parser (eqltools.com/log-parser)

- Browser-based, client-side EQL log analyzer (part of the eqltools.com fan suite). "All computation done in browser, your data stays on your computer"; reads only the tail of large logs.
- **Features:** DPS/XP/loot/healing segmented by source (player / pet / **charmed creature**), level, zone, **difficulty tier D0–D4**, and **stance × invocation combo** — a checklist of dimensions our schema must carry.
- **Limitations:** snapshot tool — no live tailing, no overlay, no persistent history, single-character perspective.
- **License: none public; closed source.** Do not lift its shipped browser JS. Feature ideas are freely reimplementable (features are not copyrightable). Their separate osxEQL launcher is MIT+LGPL.

## EQLogParser (kauffman12) — EQ1 gold standard

- C#/WPF/.NET 8, ~1,491 commits, release 2.3.56 (2026-07-12). DPS/heal/tank meters + overlays, per-player damage charts, Fight List, full trigger system with GINA import, log archiving.
- **Key lessons:** pet attribution is imperfect by necessity — charm pets are indistinguishable from same-name NPCs; their mitigation is user-correctable "Verified Players/Verified Pets" lists (**adopt: ship user-correctable entity classification, don't pretend heuristics suffice**). DoTs after caster death/zone log as "unknown" attacker (**model an unknown/environment source explicitly**). Has a per-server log-dialect toggle (**precedent for our dialect versioning**).
- **License: Apache-2.0** — may reuse with attribution/NOTICE; we port ideas anyway (C# → TS/Rust).

## rumstil/eqlogparser — best architectural reference, source-verified

- C# library, **Apache-2.0**. Nearly our planned design: stateless `ParseLine(string) → LogEvent`; ~25 pluggable event parsers **ordered most-frequent-first**; unmatched lines fall through as `LogRawEvent`; fixed-offset timestamp slice (`Substring(5,20)` + `TryParseExact`) measured faster than regex; stateful trackers layered on top (FightTracker 15 s group / 2 min raid timeouts; CharTracker friend/foe/class inference; LootTracker; BuffTracker).
- **Pet attribution (verified):** three evidence signals — generated-pet-name pattern `^[GJKLVXZ]([aeio][bknrs]){0,2}(ab|er|n|tik)$`; `/pet leader` reply `^My leader is (\w+)\.$`; pet-buff "lands-on" emotes matched to casts within 5 s (documented misattribution risk). **Adopt the multi-signal evidence model with confidence levels.**
- **DoT attribution (verified):** separate regexes for own/others'/unknown-source ticks. DPS bucketed in 6-second intervals.
- README documents EQ logging pain points verbatim: same-name mobs indistinguishable, charmed mobs unmarked, strikethrough hides defenses, no buff-fade lines — all still true in EQL until proven otherwise.

## GamParse

- Long-time EQ1 raid-guild standard (gambosoft.eqresource.com). DPS/spell/disc/tanking, accuracy/crit breakdowns, live overlay, **HTML forum export** (its adoption driver). License is Boost-1.0-style but **no public source exists** — nothing to copy; behavior freely reimplementable. Community-expected conventions: DPS = damage / player-active time; DD and DoT reported separately as an option.

## GINA (eq.gimasoft.com/gina)

- Trigger/alert app: regex triggers → TTS/sound/overlay/countdown timers; multi-character monitoring; **shareable trigger packages** (ecosystem lock-in — kauffman ships a GINA importer for a reason). Closed source, no license — ideas only. A GINA-trigger import path is legal (file-format compatibility) and a growth mechanic.

## ACT — Advanced Combat Tracker

- 20-year-old C# freeware, originally EQ2. **Core architecture lesson: the app is game-agnostic and ALL log parsing is done through plugins** — extensibility is why it survived 20 years. No license stated on core (treat as no-copy); individual plugins vary. Matches our parser-core/UI split; consider a "log dialect" abstraction so EQL format churn is a data update, not an app rewrite.

## Minor references

- `mgeitz/eqalert` (Python, P99): auto-detects most-recently-active log; **unmatched lines auto-appended to `other.json`** — good unknown-line triage pattern for a beta game whose format drifts.
- `thesmallbang/EverquestOpenParser`, `tfellison/eq-log-parser` (P99), `EJWellman/PQLogParser` (Quarm): evidence the EQ-family format forks per server era — plan for dialects.

## Feature matrix

| Feature | EQL Meter | EQL Tools | EQLogParser (kauffman) | ACT |
|---|---|---|---|---|
| Live log tailing | Y | N | Y | Y |
| Resumable offsets across restarts | P (session only) | N | P | P |
| EQL format support | Y | Y | N | N |
| DPS meter / overlay | Y | N | Y | Y |
| Healing parsing | Y | Y | Y | Y |
| Tanking/defense breakdown | P | ? | Y | Y |
| Pet→owner attribution | P (heuristic, session) | Y (claimed) | P (+ manual lists) | P |
| Charmed-creature attribution | N | Y (claimed) | P (unreliable, documented) | ? |
| DoT attribution incl. unknown-source | P | ? | Y | P |
| Encounter segmentation | Y (solo-bias) | Y | Y | Y |
| XP tracking | N | Y | P | P |
| Loot tracking | P | Y | P | P |
| Level/zone/difficulty/stance segmentation | N | Y (D0–D4, stance×invocation) | N | N |
| Triggers/alerts | N | N | Y (+GINA import) | Y |
| Persistent local DB | N | N | P (archives) | P |
| Cross-platform | Y (Win+macOS) | Y (browser) | N | N |
| Open source | Y (MIT) | N | Y (Apache-2.0) | N (core) |
| Plugin/extensibility | N | N | P (triggers) | Y |

**No tool combines: live tailing + durable local DB + group-wide encounters + evidence-based pet attribution + EQL-native segmentation (difficulty/stance/invocation/trio) + experiments. That intersection is our product.**

## Licensing implications summary

| Source | License | Copy code? | Notes |
|---|---|---|---|
| kpxcoolx/eql-meter | MIT | Yes, retain copyright notice | Regexes, tail loop, sample beta logs usable as test-corpus seed |
| rumstil/eqlogparser | Apache-2.0 | Yes, attribution + NOTICE | Port ideas; attribute lifted regex text |
| kauffman12/EQLogParser | Apache-2.0 | Yes, same terms | Mostly mine docs/UX patterns |
| GamParse | Boost-style but source unpublished | Moot — binaries only | Do not decompile; reimplement behavior |
| GINA | Closed freeware | No | Trigger-format interop importer is fine |
| ACT core | No license stated | No | Study open plugins per their own terms |
| EQL Tools site | No source/license | No | Reimplement features independently |

Net: our MIT release is unencumbered. Hard no-copy zones: ACT core, GINA, EQL Tools JS, GamParse binaries.
