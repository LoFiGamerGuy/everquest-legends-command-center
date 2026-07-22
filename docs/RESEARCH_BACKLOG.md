# Research Backlog

## Log format (feeds LOG_FORMAT_SPEC.md — needs real fixtures, never invention)
- [ ] Skill-up lines (none found in corpus yet — grep broader; trigger in-game and capture)
- [ ] Death of own character line(s); XP loss/rez lines
- [ ] AA experience gain lines (vs ability purchase, which is VERIFIED)
- [ ] Negative faction adjustments; faction cap messages
- [ ] /who output shape; group/raid join-leave lines
- [ ] Crit/lucky hit annotations; strikethrough behavior
- [ ] Difficulty-tier (D0–D4) markers in logs — how does the log reveal tier? (eqltools segments by it, so it must be derivable)
- [ ] Charm break/charm attribution lines; pet summon lines; mercenary lines if any
- [ ] Coin loot without item ("You receive X platinum..." forms); split vs solo
- [ ] Trade, vendor buy/sell, tribute, crafting lines
- [ ] Zone-instance naming (e.g., "New Sebilis Expedition" — expedition = instanced?); success/fail lines
- [ ] Log rotation behavior at size caps; multi-line messages; encoding (UTF-8?)
- [ ] Launch-dialect diff vs eql-beta-2026-07 after 2026-07-28 wipe

## Game-mechanics evidence (user-confirmed catalogs; correlate with screenshots + logs, never assume)
- [ ] AA catalog: names, ranks, costs, prereqs (ability-purchase lines give name+cost — VERIFIED source)
- [ ] Stance list per class; invocation list; their observable effects
- [ ] Race/class(trio) compatibility; skill caps by level
- [ ] Item stats (screenshot evidence inbox), drop tables (observed frequencies only)

## Product/tech
- [ ] Evaluate tauri-plugin-sql vs sidecar for write throughput at raid line rates
- [ ] Overlay always-on-top behavior under fullscreen-exclusive vs borderless
- [ ] GINA trigger-format import spec
- [ ] Installation audit follow-ups: PE metadata pass, strings pass, archive-header identification (category F/G notes) — owner-approved scope, local-only
