import { describe, expect, it } from "vitest";

import { DIALECT_EQL_BETA_2026_07, EVIDENCE_CONFIDENCE } from "@eqlcc/event-schema";
import type {
  DamageShieldEvent,
  DotTickEvent,
  EnvironmentalDamageEvent,
  EventBase,
  HealEvent,
  MeleeHitEvent,
  PetChatterEvent,
} from "@eqlcc/event-schema";

import {
  ATTRIBUTION_MIN_CONFIDENCE,
  EntityResolver,
  GENERATED_PET_NAME,
  LogParser,
  looksLikeGeneratedPetName,
  parseLogFileName,
} from "../src/index.js";

// ── Event factory (fills provenance; deterministic seq) ──────────────────────

let seq = 0;
function base(): EventBase {
  seq += 1;
  return {
    ts: 1_783_901_248_000 + seq,
    seq,
    raw: `line ${seq}`,
    byteOffset: seq * 10,
    lineNo: seq,
    logFileId: 1,
    dialectId: DIALECT_EQL_BETA_2026_07,
    ruleId: "test",
  };
}
function meleeHit(attacker: string, target: string, amount = 10): MeleeHitEvent {
  return { ...base(), type: "melee_hit", attacker, target, verb: "pierces", amount, modifiers: [] };
}
function petChatter(pet: string | null, message = "Attacking a greater skeleton Master."): PetChatterEvent {
  return { ...base(), type: "pet_chatter", pet, message };
}
function damageShield(target: string, owner: string): DamageShieldEvent {
  return { ...base(), type: "damage_shield", target, owner, amount: 11, element: "flames" };
}
function heal(healer: string, target: string): HealEvent {
  return { ...base(), type: "heal", healer, target, amount: 100 };
}
function dotTick(attacker: string | null, target: string): DotTickEvent {
  return { ...base(), type: "dot_tick", target, amount: 44, spell: "Poison", attacker };
}
function environmental(): EnvironmentalDamageEvent {
  return { ...base(), type: "environmental_damage", amount: 4, attacker: null };
}

// A pet-name matching the generator pattern ^[GJKLVXZ]([aeio][bknrs]){0,2}(ab|er|n|tik)$
const GEN_PET = "Xobtik";

describe("EntityResolver — generated-pet-name pattern", () => {
  it("matches the documented rumstil generator and rejects ordinary names", () => {
    expect(GENERATED_PET_NAME.source).toBe("^[GJKLVXZ]([aeio][bknrs]){0,2}(ab|er|n|tik)$");
    for (const name of ["Gab", "Xobtik", "Vobtik", "Kaner"]) {
      expect(looksLikeGeneratedPetName(name)).toBe(true);
    }
    for (const name of ["Playerone", "Fluffy", "a dune spiderling", "Petone"]) {
      expect(looksLikeGeneratedPetName(name)).toBe(false);
    }
  });
});

describe("EntityResolver — pet_chatter (0.95, strongest in-log signal)", () => {
  it("links pet -> owner('you') at 0.95 and classifies the pet", () => {
    const r = new EntityResolver();
    r.observe(petChatter("Petone"));

    const petone = r.resolve("Petone");
    expect(petone.kind).toBe("pet");
    expect(petone.ownerId).toBe("you");
    const link = r.get("Petone")?.ownerLink;
    expect(link?.evidenceType).toBe("pet_chatter");
    expect(link?.confidence).toBe(0.95);
    expect(link?.confidence).toBe(EVIDENCE_CONFIDENCE.pet_chatter);
    // Evidence audit trail records the signal (never a silent guess).
    expect(link?.evidence.map((e) => e.evidenceType)).toEqual(["pet_chatter"]);
  });

  it("keys owner to the log character when known (You/YOU/your normalization)", () => {
    const r = new EntityResolver({ owner: { character: "Playerone", server: "erudin", logFileId: 7 } });
    r.observe(petChatter("Petone"));
    expect(r.resolve("Petone").ownerId).toBe("Playerone");
  });

  it("the unwrapped 'Master.' report (pet: null) creates NO link (never guessed)", () => {
    const r = new EntityResolver();
    r.observe(petChatter(null, "Failed to taunt my target, Master."));
    // No pet entity was invented; nothing linked.
    expect(r.list().some((e) => e.ownerLink !== undefined)).toBe(false);
  });
});

describe("EntityResolver — damage_shield_possessive (0.7)", () => {
  it("a pet-shaped bearer whose shield burns the MOB links pet -> owner('you') at 0.7", () => {
    // "a greater skeleton is burned by <pet>'s flames" — bearer is pet-shaped and
    // the burned target is the enemy the pet tanks: a genuine pet damage shield.
    const r = new EntityResolver();
    r.observe(damageShield("a greater skeleton", GEN_PET));

    const pet = r.resolve(GEN_PET);
    expect(pet.kind).toBe("pet");
    expect(pet.ownerId).toBe("you");
    const link = r.get(GEN_PET)?.ownerLink;
    expect(link?.evidenceType).toBe("damage_shield_possessive");
    expect(link?.confidence).toBe(0.7);
    expect(link?.confidence).toBe(EVIDENCE_CONFIDENCE.damage_shield_possessive);
  });

  it("a bearer already known as a pet (via chatter) is reinforced by its DS on the mob", () => {
    const r = new EntityResolver();
    r.observe(petChatter("Petone")); // 0.95, kind=pet
    r.observe(damageShield("a greater skeleton", "Petone")); // reinforce (not generator-shaped)
    const link = r.get("Petone")?.ownerLink;
    expect(link?.ownerId).toBe("you");
    // best stays pet_chatter (0.95 > 0.7); DS is recorded in the audit trail.
    expect(link?.evidenceType).toBe("pet_chatter");
    expect(link?.evidence.map((e) => e.evidenceType)).toEqual(["pet_chatter", "damage_shield_possessive"]);
  });

  it("MAJOR A(i): an enemy DS burning YOU is NOT your pet (npc, no link, no roll-up)", () => {
    // "YOU are burned by Cazicthule's flames for 60 ..." — you hit the mob; its
    // shield burned you. The bearer is an ENEMY, never your pet.
    const r = new EntityResolver({ owner: { character: "Playerone" } });
    const enemyDs = damageShield("YOU", "Cazicthule");
    r.observe(enemyDs);

    const caz = r.resolve("Cazicthule");
    expect(caz.kind).toBe("npc");
    expect(caz.ownerId).toBeUndefined();
    expect(r.list().some((e) => e.ownerLink !== undefined)).toBe(false);
    const attribution = r.attributeSource(enemyDs);
    expect(attribution.rolledUp).toBe(false);
    expect(attribution.attributedId).toBe("Cazicthule");
  });

  it("MAJOR A(ii): an unqualified proper-name possessive on the mob makes NO pet link", () => {
    // Another player's (or a named NPC's) DS on the mob: bearer is a proper name
    // that is neither a known pet nor generator-shaped -> no owner link.
    const r = new EntityResolver();
    r.observe(damageShield("a greater skeleton", "Playertwo"));
    expect(r.resolve("Playertwo").ownerId).toBeUndefined();
    expect(r.get("Playertwo")?.ownerLink).toBeUndefined();
    expect(r.list().some((e) => e.ownerLink !== undefined)).toBe(false);
  });

  it("YOUR shield is the log owner's own — attributes to you, no pet link", () => {
    const r = new EntityResolver();
    r.observe(damageShield("a Tesch Mas Gnoll", "YOUR"));
    expect(r.list().some((e) => e.ownerLink !== undefined)).toBe(false);
    expect(r.resolve("You").kind).toBe("player");
    // Minor: case-insensitive self-possessive falls through to the same branch.
    r.observe(damageShield("a Tesch Mas Gnoll", "your"));
    expect(r.list().some((e) => e.ownerLink !== undefined)).toBe(false);
  });

  it("an article-led NPC possessive is guarded out (npc, no pet link)", () => {
    // "Playerfive is tormented by a Nisch Mal Gnoll's frost ..." -> owner "a Nisch Mal Gnoll".
    const r = new EntityResolver();
    r.observe(damageShield("Playerfive", "a Nisch Mal Gnoll"));
    const gnoll = r.resolve("a Nisch Mal Gnoll");
    expect(gnoll.kind).toBe("npc");
    expect(gnoll.ownerId).toBeUndefined();
    expect(r.list().some((e) => e.ownerLink !== undefined)).toBe(false);
  });
});

describe("EntityResolver — name_pattern (0.4) policy", () => {
  it("marks kind=pet at 0.4 but establishes NO owner link", () => {
    const r = new EntityResolver();
    r.observe(meleeHit(GEN_PET, "a greater skeleton"));

    const resolved = r.resolve(GEN_PET);
    expect(resolved.kind).toBe("pet");
    expect(resolved.confidence).toBe(0.4);
    expect(resolved.confidence).toBe(EVIDENCE_CONFIDENCE.name_pattern);
    expect(resolved.ownerId).toBeUndefined();
    expect(r.get(GEN_PET)?.kindEvidence.map((e) => e.evidenceType)).toEqual(["name_pattern"]);
  });

  it("does NOT by itself attribute damage to an owner (attributeSource returns the pet)", () => {
    const r = new EntityResolver();
    const hit = meleeHit(GEN_PET, "a greater skeleton");
    r.observe(hit);
    const attribution = r.attributeSource(hit);
    expect(attribution.rolledUp).toBe(false);
    expect(attribution.attributedId).toBe(GEN_PET);
    expect(attribution.ownerId).toBeUndefined();
    expect(attribution.confidence).toBe(0.4);
    expect(0.4).toBeLessThan(ATTRIBUTION_MIN_CONFIDENCE);
  });
});

describe("EntityResolver — attributeSource roll-up", () => {
  it("rolls a linked pet's contribution up to its owner with the link confidence", () => {
    const r = new EntityResolver({ owner: { character: "Playerone" } });
    r.observe(petChatter("Petone"));
    const a = r.attributeSource(meleeHit("Petone", "a greater skeleton"));
    expect(a.rolledUp).toBe(true);
    expect(a.sourceId).toBe("Petone");
    expect(a.attributedId).toBe("Playerone");
    expect(a.ownerId).toBe("Playerone");
    expect(a.confidence).toBe(0.95);
  });

  it("attributes a heal by the owner to the owner (You normalization)", () => {
    const r = new EntityResolver({ owner: { character: "Playerone" } });
    const a = r.attributeSource(heal("You", "Playerfive"));
    expect(a.attributedId).toBe("Playerone");
    expect(a.rolledUp).toBe(false);
  });

  it("attributes a sourceless / unknown-source contribution to explicit unknown", () => {
    const r = new EntityResolver();
    expect(r.attributeSource(environmental()).attributedId).toBe("unknown");
    expect(r.attributeSource(dotTick(null, "a greater skeleton")).attributedId).toBe("unknown");
  });
});

describe("EntityResolver — conflicting owner signals", () => {
  it("higher confidence wins regardless of order; loser recorded as conflict", () => {
    const forward = new EntityResolver();
    forward.recordOwnerSignal("Kitty", "Playertwo", "damage_shield_possessive"); // 0.7
    forward.recordOwnerSignal("Kitty", "Playerthree", "pet_chatter"); // 0.95 wins
    const fLink = forward.get("Kitty")?.ownerLink;
    expect(fLink?.ownerId).toBe("Playerthree");
    expect(fLink?.confidence).toBe(0.95);
    expect(fLink?.conflicts).toEqual([
      expect.objectContaining({ ownerId: "Playertwo", reason: "lower_confidence" }),
    ]);

    const reverse = new EntityResolver();
    reverse.recordOwnerSignal("Kitty", "Playerthree", "pet_chatter"); // 0.95 first
    reverse.recordOwnerSignal("Kitty", "Playertwo", "damage_shield_possessive"); // 0.7 rejected
    const rLink = reverse.get("Kitty")?.ownerLink;
    expect(rLink?.ownerId).toBe("Playerthree");
    expect(rLink?.confidence).toBe(0.95);
    expect(rLink?.conflicts).toEqual([
      expect.objectContaining({ ownerId: "Playertwo", reason: "lower_confidence" }),
    ]);
  });

  it("equal confidence keeps the first owner and records the conflict", () => {
    const r = new EntityResolver();
    r.recordOwnerSignal("Kitty", "Playertwo", "damage_shield_possessive"); // 0.7
    r.recordOwnerSignal("Kitty", "Playerthree", "damage_shield_possessive"); // 0.7, different owner
    const link = r.get("Kitty")?.ownerLink;
    expect(link?.ownerId).toBe("Playertwo"); // first kept
    expect(link?.confidence).toBe(0.7);
    expect(link?.conflicts).toEqual([
      expect.objectContaining({ ownerId: "Playerthree", reason: "equal_confidence_kept_first" }),
    ]);
    // All signals remain in the audit trail regardless of which won.
    expect(link?.evidence).toHaveLength(2);
  });
});

describe("EntityResolver — user assertions (Verified Players / Verified Pets)", () => {
  it("setPetOwner (user_assertion 1.0) overrides a heuristic link and locks it", () => {
    const r = new EntityResolver();
    r.observe(damageShield("a greater skeleton", GEN_PET)); // heuristic 0.7 -> owner "you"
    r.setPetOwner(GEN_PET, "Playerfour", { asserted: true });

    const link = r.get(GEN_PET)?.ownerLink;
    expect(link?.ownerId).toBe("Playerfour");
    expect(link?.evidenceType).toBe("user_assertion");
    expect(link?.confidence).toBe(1);
    expect(link?.asserted).toBe(true);
    // A later heuristic to a different owner must NOT override the locked link.
    r.recordOwnerSignal(GEN_PET, "you", "pet_chatter"); // 0.95, different owner
    expect(r.get(GEN_PET)?.ownerLink?.ownerId).toBe("Playerfour");
  });

  it("setEntityKind (user) overrides a heuristic kind and is not downgraded later", () => {
    const r = new EntityResolver();
    r.observe(meleeHit(GEN_PET, "a greater skeleton")); // name_pattern -> pet 0.4
    r.setEntityKind(GEN_PET, "player", { asserted: true });
    expect(r.resolve(GEN_PET).kind).toBe("player");
    // A subsequent heuristic pet signal appends evidence but does NOT change the user kind.
    r.recordOwnerSignal(GEN_PET, "you", "pet_chatter");
    expect(r.get(GEN_PET)?.classificationSource).toBe("user");
    expect(r.resolve(GEN_PET).kind).toBe("player");
  });

  it("MAJOR B: reclassifying a linked pet to a non-pet kind stops the roll-up (deactivates link)", () => {
    const r = new EntityResolver({ owner: { character: "Playerone" } });
    r.observe(petChatter("Petone")); // heuristic pet link -> Playerone
    expect(r.attributeSource(meleeHit("Petone", "a skeleton")).rolledUp).toBe(true);

    // User says Petone is actually a player (e.g. a same-named group member).
    r.setEntityKind("Petone", "player", { asserted: true });
    const a = r.attributeSource(meleeHit("Petone", "a skeleton"));
    expect(a.rolledUp).toBe(false);
    expect(a.attributedId).toBe("Petone");
    expect(r.resolve("Petone").ownerId).toBeUndefined(); // owner hidden while inactive
    // The link + evidence are retained for audit (never deleted), just inactive.
    expect(r.get("Petone")?.ownerLink?.active).toBe(false);
    expect(r.get("Petone")?.ownerLink?.evidence.length).toBeGreaterThan(0);
  });

  it("MAJOR (round-2): a non-pet assertion BLOCKS a later heuristic from creating an owner link", () => {
    const r = new EntityResolver({ owner: { character: "Playerone" } });
    // name_pattern classifies the entity as pet, but NO owner link yet.
    r.observe(meleeHit(GEN_PET, "a greater skeleton"));
    expect(r.get(GEN_PET)?.ownerLink).toBeUndefined();
    // User overrides: this is actually a player (e.g. a same-named group member).
    r.setEntityKind(GEN_PET, "player", { asserted: true });

    // Later owner signals (chatter, then DS) must NOT create/activate a link.
    r.recordOwnerSignal(GEN_PET, "you", "pet_chatter");
    r.observe(damageShield("a greater skeleton", GEN_PET));

    expect(r.resolve(GEN_PET).kind).toBe("player");
    expect(r.resolve(GEN_PET).ownerId).toBeUndefined();
    const link = r.get(GEN_PET)?.ownerLink;
    expect(link === undefined || link.active === false).toBe(true);
    expect(r.attributeSource(meleeHit(GEN_PET, "a skeleton")).rolledUp).toBe(false);

    // Unchanged after a snapshot round-trip.
    const revived = EntityResolver.fromSnapshot(JSON.parse(JSON.stringify(r.toSnapshot())));
    expect(revived.resolve(GEN_PET).kind).toBe("player");
    expect(revived.resolve(GEN_PET).ownerId).toBeUndefined();
    const rLink = revived.get(GEN_PET)?.ownerLink;
    expect(rLink === undefined || rLink.active === false).toBe(true);
    // A further heuristic after reload still cannot create an active link.
    revived.recordOwnerSignal(GEN_PET, "you", "pet_chatter");
    expect(revived.resolve(GEN_PET).ownerId).toBeUndefined();
  });
});

describe("EntityResolver — snapshot persistence (survives reload)", () => {
  it("round-trips classifications, user assertions, and evidence exactly", () => {
    const r = new EntityResolver({ owner: { character: "Playerone", server: "erudin", logFileId: 3 } });
    r.observe(petChatter("Petone")); // heuristic pet link
    r.observe(meleeHit(GEN_PET, "a greater skeleton")); // name_pattern pet, no owner
    r.setEntityKind("Playerfive", "player", { asserted: true });
    r.setPetOwner("Pettwo", "Playerone", { asserted: true }); // user link

    const snapshot = r.toSnapshot();
    // Snapshot is plain JSON (DB-persistable): survives a serialize round-trip.
    const revived = EntityResolver.fromSnapshot(JSON.parse(JSON.stringify(snapshot)));

    expect(revived.owner.character).toBe("Playerone");
    // Heuristic pet link preserved.
    expect(revived.resolve("Petone").ownerId).toBe("Playerone");
    expect(revived.get("Petone")?.ownerLink?.evidenceType).toBe("pet_chatter");
    // name_pattern classification preserved (kind + evidence), still no owner.
    expect(revived.resolve(GEN_PET).kind).toBe("pet");
    expect(revived.get(GEN_PET)?.kindEvidence.map((e) => e.evidenceType)).toEqual(["name_pattern"]);
    expect(revived.resolve(GEN_PET).ownerId).toBeUndefined();
    // User assertions preserved and still locking.
    expect(revived.resolve("Playerfive").kind).toBe("player");
    expect(revived.get("Playerfive")?.classificationSource).toBe("user");
    const petLink = revived.get("Pettwo")?.ownerLink;
    expect(petLink?.ownerId).toBe("Playerone");
    expect(petLink?.asserted).toBe(true);
    // Locked link is still not overridable after reload.
    revived.recordOwnerSignal("Pettwo", "you", "pet_chatter");
    expect(revived.get("Pettwo")?.ownerLink?.ownerId).toBe("Playerone");

    // MINOR C: every linked owner id must resolve to a real entity (FK integrity).
    const ids = new Set(revived.list().map((e) => e.canonical));
    for (const e of revived.list()) {
      if (e.ownerLink !== undefined) expect(ids.has(e.ownerLink.ownerId)).toBe(true);
    }
  });

  it("MAJOR B: a user non-pet reclassification keeps roll-up OFF across a snapshot reload", () => {
    const r = new EntityResolver({ owner: { character: "Playerone" } });
    r.observe(petChatter("Petone")); // heuristic pet link
    r.setEntityKind("Petone", "npc", { asserted: true }); // deactivates the link

    const revived = EntityResolver.fromSnapshot(JSON.parse(JSON.stringify(r.toSnapshot())));
    expect(revived.resolve("Petone").kind).toBe("npc");
    expect(revived.get("Petone")?.ownerLink?.active).toBe(false);
    // Still no roll-up after reload; a stale link cannot resurrect booking damage.
    expect(revived.attributeSource(meleeHit("Petone", "a skeleton")).rolledUp).toBe(false);
  });

  it("MINOR C: recordOwnerSignal registers the owner so the link never dangles", () => {
    const r = new EntityResolver();
    r.recordOwnerSignal("Kitty", "Playertwo", "pet_chatter");
    expect(r.get("Playertwo")).toBeDefined();
    const owner = r.get("Kitty")?.ownerLink?.ownerId;
    expect(owner).toBe("Playertwo");
    expect(r.list().some((e) => e.canonical === owner)).toBe(true);
  });
});

describe("EntityResolver — file-name owner derivation", () => {
  it("parses eqlog_<Character>_<server>.txt", () => {
    expect(parseLogFileName("eqlog_Playerone_erudin.txt")).toEqual({
      character: "Playerone",
      server: "erudin",
    });
    expect(parseLogFileName("/logs/eqlog_Playerone_erudin.txt")?.character).toBe("Playerone");
    expect(parseLogFileName("notalog.txt")).toBeNull();
  });

  it("forLogFile keys You/character normalization to the parsed character", () => {
    const r = EntityResolver.forLogFile("eqlog_Playerone_erudin.txt", 5);
    expect(r.owner).toMatchObject({ character: "Playerone", server: "erudin", logFileId: 5 });
    expect(r.resolve("You").canonical).toBe("Playerone");
    expect(r.resolve("YOU").canonical).toBe("Playerone");
    expect(r.resolve("your").canonical).toBe("Playerone");
    expect(r.resolve("Playerone").canonical).toBe("Playerone");
  });
});

// ── Integration: guard the false-positive class through the REAL parser ───────

describe("EntityResolver — end-to-end via LogParser (false-positive guard)", () => {
  const lines = [
    "[Mon Jul 13 00:07:28 2026] Petone told you, 'Attacking a greater skeleton Master.'",
    "[Mon Jul 13 00:07:30 2026] Dougina told you, 'That'll be 0 money for the Package for Old Doug.'",
    "[Mon Jul 13 00:07:31 2026] Doug Jr told you, 'Welcome to my bank!'",
  ].join("\n");

  it("real pet chatter links; merchant/banker 'told you' tells do NOT create a pet link", () => {
    const parser = new LogParser({ logFileId: 1 });
    const resolver = EntityResolver.forLogFile("eqlog_Playerone_erudin.txt", 1);
    for (const event of parser.parseText(lines)) resolver.observe(event);

    // The genuine pet report is attributed.
    expect(resolver.resolve("Petone").kind).toBe("pet");
    expect(resolver.resolve("Petone").ownerId).toBe("Playerone");
    // Merchant/banker tells were chat_message events -> ignored by the resolver.
    expect(resolver.resolve("Dougina").ownerId).toBeUndefined();
    expect(resolver.resolve("Doug Jr").ownerId).toBeUndefined();
    // Exactly one pet link exists.
    expect(resolver.list().filter((e) => e.ownerLink !== undefined).map((e) => e.canonical)).toEqual([
      "Petone",
    ]);
  });
});
