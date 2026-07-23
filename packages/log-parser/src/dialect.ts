/**
 * Plural dialect model (LAUNCH_DIALECT_READINESS.md §1).
 *
 * A `Dialect` bundles a `DialectId` with its ordered recognizer `rules` and an
 * optional `DialectBaseline` (expected per-family line shares, §3). A
 * `DialectRegistry` holds several named dialects so the parser can be pointed at
 * whichever dialect a given log file speaks.
 *
 * `eql-beta-2026-07` registers from the current rule set UNCHANGED, so the
 * existing single-dialect parse path is byte-for-byte identical (backward
 * compatible — beta stays the default; see parser.ts, which never touches this
 * module).
 *
 * Extends/override: a derived dialect declares `extends: <baseId>` and lists
 * only the rules that changed. Rule identity is `ruleId`; a derived rule with a
 * base rule's `ruleId` SUPERSEDES it, and a rule with a new `ruleId` is ADDED.
 * Every unchanged base rule is reused verbatim. This is the mechanism that lets
 * a future `eql-launch-2026-07` be a small data diff rather than a code rewrite
 * (§1). This ticket ships ONLY the machinery — no launch rules are authored
 * here (those need real, anonymized launch fixtures; §6 "out of scope").
 */

import type { DialectId } from "@eqlcc/event-schema";
import { DIALECT_EQL_BETA_2026_07 } from "@eqlcc/event-schema";

import type { RecognizerRule } from "./rule.js";
import { RecognizerRegistry, allRules } from "./registry.js";
import { BETA_BASELINE } from "./baselines/eql-beta-2026-07.js";

/**
 * Expected share of recognized lines per event family for a dialect
 * (LAUNCH_DIALECT_READINESS.md §3). Committed as data; consumed by
 * `driftReport` to spot a family whose wording silently drifted to
 * `raw_unknown`. See `src/baselines/` for how each baseline is produced.
 */
export interface DialectBaseline {
  dialectId: DialectId;
  /**
   * family -> share in [0, 1] of *recognized* lines (shares sum to ~1 across
   * recognized families; the overall unmatched rate is tracked separately so a
   * family dropping out shows up both as a share drop here and as a rise in the
   * overall rate).
   */
  familyShares: Readonly<Record<string, number>>;
  /** Provenance note: how these numbers were produced (for auditability). */
  source: string;
}

/** A registered dialect: id + ordered rules (+ optional baseline). */
export interface Dialect {
  id: DialectId;
  /** Effective, frequency-ordered rules (base ∪ overrides, resolved). */
  rules: readonly RecognizerRule[];
  baseline?: DialectBaseline;
}

/** Declaration passed to `DialectRegistry.register` (pre-resolution). */
export interface DialectDefinition {
  id: DialectId;
  /** Base dialect id to inherit rules from; omit for a root dialect. */
  extends?: DialectId;
  /**
   * Rules to add or override. When `extends` is set, a rule here whose `ruleId`
   * matches a base rule replaces it; a new `ruleId` is appended. Without
   * `extends`, this is the dialect's full rule set.
   */
  rules: readonly RecognizerRule[];
  baseline?: DialectBaseline;
}

/**
 * Resolve `extends`/override into the flat effective rule set: base rules keyed
 * by `ruleId`, then each declaration rule set on top (same id overrides, new id
 * adds). Insertion order is preserved for stability; the RecognizerRegistry
 * re-sorts by `frequencyRank` and enforces uniqueness.
 */
function resolveRules(
  def: DialectDefinition,
  base: readonly RecognizerRule[],
): RecognizerRule[] {
  const byId = new Map<string, RecognizerRule>();
  for (const rule of base) byId.set(rule.ruleId, rule);
  for (const rule of def.rules) byId.set(rule.ruleId, rule);
  return [...byId.values()];
}

/**
 * Holds named dialects and hands out a recognizer for each. Registering
 * `eql-beta-2026-07` from `allRules()` reproduces today's behavior exactly.
 */
export class DialectRegistry {
  private readonly dialects = new Map<DialectId, Dialect>();
  private readonly recognizers = new Map<DialectId, RecognizerRegistry>();

  /**
   * Register a dialect, resolving `extends`/override. Throws on a duplicate id,
   * an unknown base, or a rule set the RecognizerRegistry rejects (duplicate
   * `ruleId`/`frequencyRank`). Returns the resolved dialect.
   */
  register(def: DialectDefinition): Dialect {
    if (this.dialects.has(def.id)) {
      throw new Error(`dialect already registered: ${def.id}`);
    }
    let base: readonly RecognizerRule[] = [];
    if (def.extends !== undefined) {
      const parent = this.dialects.get(def.extends);
      if (parent === undefined) {
        throw new Error(`dialect ${def.id} extends unregistered dialect ${def.extends}`);
      }
      base = parent.rules;
    }
    const resolved = resolveRules(def, base);
    // Constructing the recognizer validates uniqueness and yields the ordered
    // manifest we store as the effective rules.
    const recognizer = new RecognizerRegistry(resolved);
    const dialect: Dialect = {
      id: def.id,
      rules: recognizer.manifest,
      ...(def.baseline !== undefined ? { baseline: def.baseline } : {}),
    };
    this.dialects.set(def.id, dialect);
    this.recognizers.set(def.id, recognizer);
    return dialect;
  }

  has(id: DialectId): boolean {
    return this.dialects.has(id);
  }

  get(id: DialectId): Dialect | undefined {
    return this.dialects.get(id);
  }

  /** Registered dialect ids, in registration order. */
  ids(): DialectId[] {
    return [...this.dialects.keys()];
  }

  get size(): number {
    return this.dialects.size;
  }

  /** A ready recognizer for a dialect (cached), or `undefined` if unknown. */
  recognizerFor(id: DialectId): RecognizerRegistry | undefined {
    return this.recognizers.get(id);
  }
}

/**
 * The default registry: just `eql-beta-2026-07`, from the current rules and the
 * committed beta baseline. A single registered dialect means `detectDialect`
 * always returns beta — zero behavior change for existing callers.
 */
export function createDefaultDialectRegistry(baseline: DialectBaseline = BETA_BASELINE): DialectRegistry {
  const registry = new DialectRegistry();
  registry.register({
    id: DIALECT_EQL_BETA_2026_07,
    rules: allRules(),
    baseline,
  });
  return registry;
}
