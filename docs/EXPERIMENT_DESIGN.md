# Experiment Design

How the Laboratory produces honest comparisons instead of anecdotes.

## Principles
1. **Define the metric before the run** (e.g., DPS over active combat time; XP/hour wall-clock vs active).
2. **Control what you can, record what you can't**: every experiment session records zone, difficulty tier, stance, invocation, level, gear-change events, group composition. Uncontrolled variance is reported, not hidden.
3. **Paired designs preferred**: A/B alternating pulls in the same camp beat sequential sessions.
4. **Sample-size honesty**: report n (encounters, hits), confidence intervals (bootstrap over encounters), and refuse to declare a winner below minimum n; surface overlap explicitly.
5. **Provenance**: every aggregate links back to the encounter list → events → raw lines.

## v1 experiment types
- Weapon A/B (damage distribution per swing, procs)
- Stance × invocation grid comparison
- AA before/after (same target population)
- Route/camp XP-rate comparison
- Class-trio leveling race timelines

## Confounders checklist (recorded per session)
Level deltas · difficulty tier · group/pet composition · buffs present (as observable) · target mix (mob types/levels) · downtime definition (active vs AFK threshold) · dialect/patch version (game patches change numbers!).

## Statistical notes
Encounters are the resampling unit (hits within an encounter are correlated). Patch boundaries split datasets automatically (dialect tag + client version from logs when available).
