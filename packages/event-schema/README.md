# @eqlcc/event-schema

Typed, append-only event model for EQL Command Center. **Pure TypeScript, zero
runtime dependencies** — it may be imported from anywhere (parser worker, Node
CLI, database layer, UI) without pulling anything along (ARCHITECTURE.md §2).

## The model

- **`LogEvent`** — a discriminated union (discriminant: `type`) of the 30 event
  families in docs/LOG_FORMAT_SPEC.md §5. Discriminant values are the
  snake_case strings stored in the `events.type` column (DATA_MODEL.md §2),
  e.g. `MeleeHitEvent` has `type: "melee_hit"`.
- **Provenance on every event** (`EventBase`): `ts` (epoch ms), `raw` (the
  verbatim line), `byteOffset`, `lineNo`, `logFileId`, `dialectId`, `ruleId`.
  Nothing is ever emitted without its raw line and source offset (ADR-3);
  `ruleId` is `null` only for `raw_unknown`.
- **Explicit unknowns, never guesses**: where the log gives no source (orphan
  DoT ticks, `X died.`, environmental damage) the field is explicitly `null`.
- **Lossless integers**: XP is integer milli-percent (`1.019%` → `1019`), money
  is integer copper (`1p=1000c, 1g=100c, 1s=10c`). No floats in domain data.
- **Entities are plain strings** at this layer, exactly as written in the line.
  Name → entity resolution (and pet → owner linking) happens downstream using
  the shared enums exported here: `EntityKind`, `EvidenceType`, and the ADR-006
  default confidence weights `EVIDENCE_CONFIDENCE` (`pet_chatter` 0.95,
  `damage_shield_possessive` 0.7, `name_pattern` 0.4, `user_assertion` 1.0).
- **Reserved types**: `cast_interrupt`, `skill_up`, `spell_resist` are
  UNVERIFIED in the spec (no fixture). The types exist so downstream schemas
  are stable, but no recognizer may emit them until a real line lands
  (`EVENT_TYPE_STATUS` marks them `"reserved"`). `raw_unknown` is always on —
  every unmatched line is retained.

## Helpers

```ts
import { isEventType, assertNever, EVENT_TYPES } from "@eqlcc/event-schema";

if (isEventType(event, "melee_hit")) event.amount; // narrowed

switch (event.type) {
  /* ...all 30 cases... */
  default:
    assertNever(event); // compile error if a case is missing
}
```

`EVENT_TYPES` (all 30 discriminants, spec §5 order) and `EVENT_TYPE_STATUS`
(`verified` / `reserved` / `always`) support iteration and diagnostics.

## Change policy

Adding or changing an event family follows the fixture policy: spec first
(docs/LOG_FORMAT_SPEC.md), real anonymized fixture + test alongside any
recognizer. Never fabricate a line format.
