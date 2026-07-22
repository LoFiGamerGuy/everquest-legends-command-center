# Product Vision

## The problem

EverQuest Legends players have no way to answer, with evidence, the questions the game constantly poses: Which stance and invocation actually yields more DPS for my build? Is my pet contributing what I think? What's my real XP/hour on this route at this difficulty tier? Which class trio levels fastest? Existing tools are either ephemeral overlays with no history (EQL Meter), snapshot analyzers with no live view (EQL Tools), or EQ1 tools that don't speak EQL's dialect.

## The product

A local-first desktop command center that turns your own log files into a queryable, comparable, visual record of everything you play — live while you play it, and forever after.

Three layers:
1. **Tracker** — live session dashboard: DPS/HPS, encounters, kills/deaths, XP & AA rates, loot & coin, skill-ups, faction, zone/stance/invocation timeline; compact always-on-top mode.
2. **Laboratory** — A/B experiments (weapon vs weapon, stance vs stance, AA before/after), leveling-race and build comparisons, route analysis, difficulty-tier segmentation — with explicit statistical honesty about sample sizes.
3. **Command center** — customizable dashboards, user-confirmed evidence catalogs (AA/spells/items/abilities with provenance and confidence), privacy-safe exports, AI-assisted analysis grounded only in your normalized local data.

## What we will never build

Anything in docs/COMPLIANCE_BOUNDARIES.md's forbidden list. The product is passive and informational, full stop.

## Differentiators

Durable local history (SQLite) · group-wide encounter model · evidence-based pet/charm attribution with user correction · EQL-native dimensions (difficulty D0–D4, stance × invocation, class trio) · every number traceable to raw log lines · open source, no account, no telemetry.

## Non-goals (v1)

Raid-service log hosting, cross-player leaderboards, mobile apps, cloud sync.
