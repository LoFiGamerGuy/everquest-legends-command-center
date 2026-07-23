# EverQuest Legends Log Format Specification

**Status:** Draft v0.1 (2026-07-22) · **Dialect:** `eql-beta-2026-07`
**Grounding rule:** every "VERIFIED" example below is a real captured line from the July 2026 beta,
anonymized per repo policy (player names → `Playerone`, `Playertwo`, …; pet names → `Petone`, `Pettwo`;
mob/spell/zone/item names and all numbers/punctuation preserved exactly). Anything without a fixture is
marked **UNVERIFIED — needs fixture** and MUST NOT be implemented as a recognizer until a real sample
lands in `tests/fixtures/`. We never invent line formats.

Regexes below apply to the **message body** (after the timestamp prefix is sliced off, §2). All are
anchored `^…$`, use named capture groups, and are ordered most-frequent-first at runtime (ARCHITECTURE.md
ADR-2).

---

## 1. File naming and location

- Directory: `Logs/` under the EQL install/user directory. *(Exact platform paths: UNVERIFIED — needs
  confirmation per OS.)*
- Filename: `eqlog_<Character>_<server>.txt` — one file per character per server.
- Servers observed so far: `erudin`, `freeport`, `neriak`, `qeynos`, `halas`, `oggok`, `rivervale`,
  `paineel`.
- Logging is toggled in-game; the toggle itself is logged (§4.19).
- Encoding: assumed Windows-1252 like classic EQ. **UNVERIFIED — needs a fixture containing non-ASCII.**

## 2. Line structure and timestamp

```
[Day Mon DD HH:MM:SS YYYY] <message>
```

Classic EQ asctime style, **local time**. The prefix is fixed-width: `[` + 24-char asctime + `] `.
Parse by slicing bytes 1–24 (0-indexed `line[1..25]`); the message body starts at offset 27. No regex
needed for the timestamp (community-measured win, rumstil/eqlogparser).

Open questions:
- Day-of-month padding for days 1–9 (`Jul  5` space-padded vs `Jul 5`): **UNVERIFIED — needs fixture.**
  The slicer tolerates both; goldens must pin it once observed.
- Sub-second precision: none observed. Parser assigns a monotonic per-second sequence for stable
  ordering.
- DST transitions produce ambiguous/backwards local timestamps: handled by monotonic clamping, policy
  documented in parser.

## 3. Grammar conventions observed

- The logging character is `You`/`YOU`/`your` (case signals subject vs object position).
- NPCs appear with lowercase article: `a dune spiderling`, `an armadillo`. Named NPCs appear bare:
  `Hoptor Thaggelum`. Players/pets appear as bare capitalized names.
- Pets self-identify via tells (§4.17). Real pet names observed match the classic EQ pet-name generator
  `^[GJKLVXZ]([aeio][bknrs]){0,2}(ab|er|n|tik)$` (community knowledge, rumstil) — usable as weak
  `name_pattern` evidence only.

---

## 4. Event families

Legend: **V** = VERIFIED (fixture exists) · **U** = UNVERIFIED — needs fixture.

### 4.1 Melee hit → `MeleeHit` (V)

```
You pierce a rambunctious pet for 5 points of damage.
A rambunctious pet punches YOU for 3 points of damage.
Petone pierces a fragile pet for 4 points of damage.
```

Discriminator vs spell damage: melee ends `points of damage.` with **no** damage school and no `by <spell>`.

```regex
^(?<attacker>You|.+?) (?<verb>[a-z]+?)e?s? (?<target>YOU|.+?) for (?<amount>\d+) points? of damage\.$
```

Implementation note: the verb list must be a closed set to avoid false positives. Verbs verified so far:
`pierce/pierces`, `punches`. Expected classic set (`slash, crush, hit, kick, bash, bite, backstab, …`):
**U** per verb — add to the set only with fixtures. Singular `point of damage` for 1: **U** (classic EQ
does this; regex already tolerates it).

Open: critical hits, "You strike through", finishing blows — **U**.

### 4.2 Melee miss / defense → `MeleeMiss` (V)

```
Petone tries to pierce a dune spiderling, but misses!
A dune spiderling tries to bite YOU, but misses!
A wan ghoul knight tries to bash YOU, but YOU riposte!
A wan ghoul knight tries to hit YOU, but misses! (Riposte)
```

```regex
^(?<attacker>.+?) tries to (?<verb>[a-z]+) (?<target>YOU|.+?), but (?<outcome>misses|YOU riposte|.+?)!(?: \((?<annotation>[A-Za-z ]+)\))?$
```

Payload: `outcome` normalized to `miss | riposte | …`; `annotation` (e.g. `Riposte` on a miss line —
apparently the riposte *attempt* that itself missed) kept verbatim. Verified verbs here: `pierce`,
`bite`, `bash`, `hit`. Dodge / parry / block / shield block / miss-by-third-parties phrasing: **U**.

### 4.3 Direct spell damage → `SpellDamage` (V)

```
You hit a dune spiderling for 3 points of fire damage by Burst of Flame.
Petone hit a dune spiderling for 12 points of magic damage by Harm Touch.
```

```regex
^(?<attacker>You|.+?) hits? (?<target>.+?) for (?<amount>\d+) points? of (?<school>[a-z]+) damage by (?<spell>.+?)\.$
```

Schools verified: `fire`, `magic`. Others (cold, poison, disease, corruption…): **U**. Note `Petone hit`
(no `s`) — third person without the `s` is verified; the regex accepts both. Resists, partial resists,
spell crits: **U**.

### 4.4 DoT tick → `DotTick` (V)

```
Playerfour has taken 1 damage from Feeble Poison by a gila monster hatchling.
A wan ghoul knight has taken 44 damage from your Blood Siphon Strike.
```

Two forms — check `from your` first:

```regex
^(?<target>.+?) has taken (?<amount>\d+) damage from your (?<spell>.+?)\.$
^(?<target>.+?) has taken (?<amount>\d+) damage from (?<spell>.+?) by (?<attacker>.+?)\.$
```

Community knowledge (rumstil): expect an **unknown-source** form once the caster dies/zones (classic:
`... has taken N damage by <spell>.`) — emit `DotTick` with explicit `attacker: unknown`, never guess.
That form is **U** in EQL.

### 4.5 Damage shield → `DamageShield` (V)

```
A greater skeleton is burned by Pettwo's flames for 11 points of non-melee damage.
```

```regex
^(?<target>.+?) is burned by (?<owner>.+?)'s flames for (?<amount>\d+) points of non-melee damage\.$
```

The possessive `owner` is pet/player attribution evidence (`damage_shield_possessive`). Non-fire DS
wording (thorns, chill…): **U**.

### 4.6 Environmental / untyped damage → `EnvironmentalDamage` (V)

```
You were hit by non-melee for 4 damage.
```

```regex
^You were hit by non-melee for (?<amount>\d+) damage\.$
```

Sourceless by design; emitted with `attacker: unknown`. Falls, drowning, lava wording: **U**.

### 4.7 Heal → `Heal` (V)

```
You healed Playerone for 4 hit points by Lifetap.
Petone healed itself for 0 (4) hit points by Lifetap.
You healed Playertwo for 141 (399) hit points by Greater Healing.
```

```regex
^(?<healer>You|.+?) healed (?<target>itself|himself|herself|.+?) for (?<amount>\d+)(?: \((?<uncapped>\d+)\))? hit points? by (?<spell>.+?)\.$
```

Parenthesized value = **uncapped** heal; `amount` is the landed (capped) heal; overheal =
`uncapped - amount`. Note a 0-point heal is a real line. Third-party heals on you / HoT tick wording: **U**.

### 4.8 Rune / absorption → `RuneAbsorb` (V)

```
You gain a rune for 12 points of absorption.
```

```regex
^You gain a rune for (?<amount>\d+) points of absorption\.$
```

Others gaining runes; rune consumption/fade lines: **U**.

### 4.9 Kill / death → `Kill`, `Death` (V)

```
A fragile pet has been slain by Petone!
You have slain a dune spiderling!
Playerthree died.
```

```regex
^(?<target>.+?) has been slain by (?<killer>.+?)!$
^You have slain (?<target>.+?)!$
^(?<name>\S+) died\.$
```

`X died.` (bare capitalized name) observed for what appears to be a player death → emit `Death` with
`entity: name`, killer unknown. Your own death wording, `You have been slain by …`: **U**.

### 4.10 Experience → `XpGain` (V)

```
You gain experience! (1.019%)
You gain experience! (4.000%)
```

```regex
^You gain experience! \((?<percent>\d+\.\d+)%\)$
```

EQL logs the **exact percentage** (3 decimals observed) — a major analytics upgrade over classic EQ.
Store lossless as milli-percent. Group/raid-bonus phrasing variants, AA experience line: **U**.

### 4.11 Level up → `LevelUp` (V)

```
You have gained a level! Welcome to level 2!
```

```regex
^You have gained a level! Welcome to level (?<level>\d+)!$
```

### 4.12 Ability purchase → `AbilityPurchase` (V)

```
You have gained the ability "Origin" at a cost of 0 ability points.
```

```regex
^You have gained the ability "(?<ability>.+?)" at a cost of (?<cost>\d+) ability points?\.$
```

Earning AA points (as opposed to spending): **U**.

### 4.13 Loot (kept) → `LootItem` (V)

```
--You have looted a Fragile Pet's Skull from a fragile pet's corpse.--
```

Note the `--…--` wrapper.

```regex
^--You have looted (?<article>a|an|\d+) (?<item>.+?) from (?<corpse>.+?)'s corpse\.--$
```

`article` as digits (stack count) is inferred from §4.14's `2 Armadillo Husk` pattern but is **U** for
the kept-loot wrapper form. Master-loot / other players looting: **U**.

### 4.14 Loot auto-sold → `LootAutoSell` (V)

```
You looted 2 Armadillo Husk from an armadillo's corpse and sold it for 1 silver and 8 copper.
You looted a Jade Earring from a dar ghoul knight's corpse and sold it for 3 platinum, 2 gold, 1 silver and 4 copper.
```

```regex
^You looted (?<count>\d+|a|an) (?<item>.+?) from (?<corpse>.+?)'s corpse and sold it for (?<price>.+?)\.$
```

`price` sub-parsed as a comma/`and`-joined list of `(?<n>\d+) (?<denom>platinum|gold|silver|copper)`;
denominations only present when nonzero; convert to integer copper (1p=1000c, 1g=100c, 1s=10c). Emits
`LootAutoSell` and drives `currency_ledger`. Zero-value sale wording: **U**.

### 4.15 Zone change → `ZoneEnter` (V)

```
You have entered The Northern Desert of Ro.
You have entered New Sebilis Expedition.
```

```regex
^You have entered (?<zone>.+?)\.$
```

`… Expedition` suffix suggests instanced content (heuristic `is_instance`). Caution: classic EQ reuses
`You have entered …` for PvP/arena flags — keep this rule late in the order and watch unknown stats.
Zone-out / loading phrasing: **U**.

### 4.16 Stance & invocation → `StanceChangeBegin`/`StanceChange`, `InvocationChangeBegin`/`InvocationChange` (V)

EQL-specific mechanics; first-class analytics dimensions (stance × invocation).

```
You begin to change your stance.
You assume a berserker stance.
You assume a channeler stance.
You begin to change your invocation.
You begin reciting the recovery invocation.
You begin reciting the spellblade invocation.
```

```regex
^You begin to change your stance\.$
^You assume a (?<stance>.+?) stance\.$
^You begin to change your invocation\.$
^You begin reciting the (?<invocation>.+?) invocation\.$
```

Stances verified: `berserker`, `channeler`. Invocations verified: `recovery`, `spellblade`. Full lists,
failure/interruption of the change, other players' stances: **U**. Open question: does "begin reciting"
complete implicitly, or is there a completion line? **U** — until known, `InvocationChange` is emitted
at the `begin reciting` line.

### 4.17 Casting → `CastBegin`, `CastResume` (V); `CastInterrupt` (U)

```
You begin casting Cavorting Bones.
Hoptor Thaggelum begins casting Animate Dead.
You regain your concentration and continue your casting.
```

```regex
^(?<caster>You|.+?) begins? casting (?<spell>.+?)\.$
^You regain your concentration and continue your casting\.$
```

Interrupt (`Your spell is interrupted.` in classic), fizzle, out-of-mana: **U** — reserved event type
`CastInterrupt`, no recognizer until fixtured.

### 4.18 Faction → `FactionChange` (V)

```
Your faction standing with New Sebilisian Expedition has been adjusted by 100.
```

```regex
^Your faction standing with (?<faction>.+?) has been adjusted by (?<delta>-?\d+)\.$
```

Positive delta verified; negative form assumed symmetric but **U**. "Could not possibly get any
better/worse" caps: **U**.

### 4.19 Pet chatter → `PetChatter` (V) — attribution gold

```
Petone told you, 'Attacking a dune spiderling Master.'
Petone told you, 'Attacking an armadillo Master.'
```

```regex
^(?<pet>\S+) told you, '(?<message>.+)'$
```

With sub-match `^Attacking (?<target>.+?) Master\.$`. This is the strongest pet→owner evidence
(`pet_chatter`, confidence 0.95): a bare-named entity telling *you* "… Master." is your pet, and it also
names the pet's current target. Other pet messages (following, guarding, "My leader is …" report): **U**.

### 4.20 Chat channels → `ChatMessage` (V)

```
Playerfive tells General:2, '...'
Playersix tells NewPlayers:1, '...'
```

Channel identity is `Name:number`.

```regex
^(?<speaker>\S+) tells (?<channel>[A-Za-z]+):(?<number>\d+), '(?<message>.+)'$
```

Say / group / guild / raid / ooc / shout / auction / direct tells: **U** — each needs its own fixture;
classic phrasings must not be assumed.

### 4.21 Logging toggle → `LogToggle` (V)

```
Logging to 'eqlog.txt' is now *ON*.
```

```regex
^Logging to '(?<file>.+?)' is now \*(?<state>ON|OFF)\*\.$
```

`OFF` form: **U** (accepted by regex, unconfirmed wording). Session engine uses this as a session
boundary hint.

### 4.22 Skill increase → `SkillUp` (U)

**UNVERIFIED — needs fixture.** No EQL sample captured. Classic wording
(`You have become better at X! (N)`) MUST NOT be assumed. Event type and `skill_events` table are
reserved; no recognizer ships until a real line lands.

### 4.23 Everything else → `RawUnknown` (always on)

Any line matching no recognizer is emitted as `RawUnknown` with raw text + offset, and aggregated into
`unknown_line_stats`. This is the fixture pipeline for expanding this spec.

---

## 5. Event type enum (initial, `packages/event-schema`)

| # | Type | Status | # | Type | Status |
|---|------|--------|---|------|--------|
| 1 | `MeleeHit` | V | 16 | `ZoneEnter` | V |
| 2 | `MeleeMiss` | V | 17 | `StanceChangeBegin` | V |
| 3 | `SpellDamage` | V | 18 | `StanceChange` | V |
| 4 | `DotTick` | V | 19 | `InvocationChangeBegin` | V |
| 5 | `DamageShield` | V | 20 | `InvocationChange` | V |
| 6 | `EnvironmentalDamage` | V | 21 | `CastBegin` | V |
| 7 | `Heal` | V | 22 | `CastResume` | V |
| 8 | `RuneAbsorb` | V | 23 | `CastInterrupt` | U (reserved) |
| 9 | `Kill` | V | 24 | `FactionChange` | V |
| 10 | `Death` | V | 25 | `SkillUp` | U (reserved) |
| 11 | `XpGain` | V | 26 | `PetChatter` | V |
| 12 | `LevelUp` | V | 27 | `ChatMessage` | V |
| 13 | `AbilityPurchase` | V | 28 | `LogToggle` | V |
| 14 | `LootItem` | V | 29 | `SpellResist` | U (reserved) |
| 15 | `LootAutoSell` | V | 30 | `RawUnknown` | always |

All payload interfaces carry: `raw`, `byteOffset`, `logFileId`, `ts`, `dialectId`, `ruleId`.

---

## 6. Fixture policy

- Path: `tests/fixtures/eql-beta-2026-07/<family>.txt` — full raw lines including timestamp prefix.
- Anonymization (mandatory before commit): player names → `Playerone…`, pet names → `Petone…`; keep
  mob/spell/zone/item names, numbers, and punctuation byte-exact.
- One recognizer change = at least one fixture line + golden expected-event JSON.
- Never hand-write fixture lines. If you need a format, go capture it.
