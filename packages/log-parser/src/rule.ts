/**
 * Recognizer rule model (ARCHITECTURE.md §6, ADR-2).
 *
 * A rule matches a *message body* (timestamp prefix already sliced off) and
 * returns a typed event payload, or `null`. Rules are anchored, named-group
 * regexes from LOG_FORMAT_SPEC.md — or exact-string dictionaries where the
 * wording is a closed, fixture-backed set. First match wins; rules are ordered
 * most-frequent-first by corpus-measured `frequencyRank`.
 *
 * Every rule carries `{ruleId, dialectId, frequencyRank}` so any parse is
 * traceable to the exact rule (and fixture) that justified it.
 */

import type { DialectId, EventBase, LogEvent, RawUnknownEvent } from "@eqlcc/event-schema";
import { DIALECT_EQL_BETA_2026_07 } from "@eqlcc/event-schema";

/** Distributive Omit — keeps the union a union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A recognized event minus provenance (the registry adds `EventBase`). */
export type EventPayload = DistributiveOmit<Exclude<LogEvent, RawUnknownEvent>, keyof EventBase>;

export interface RecognizerRule {
  /** Stable id, recorded on every emitted event (`events.rule_id`). */
  ruleId: string;
  /** Dialect that verified this wording (ARCHITECTURE.md §6). */
  dialectId: DialectId;
  /** Event family, for diagnostics/reporting. */
  family: string;
  /**
   * Corpus-measured ordering: smaller = more frequent = tried earlier
   * (eql-beta-2026-07 benchmark, 434k lines). Correctness constraints
   * (e.g. `death-you` before `kill-other`) are encoded in these numbers too.
   */
  frequencyRank: number;
  /** Return the payload, or `null` when the message is not this rule's. */
  match(message: string): EventPayload | null;
}

interface RegexRuleOptions {
  ruleId: string;
  family: string;
  frequencyRank: number;
  /** Anchored (`^…$`) regex with named capture groups (LOG_FORMAT_SPEC.md). */
  regex: RegExp;
  /** Build the payload from a successful match; may still veto with `null`. */
  build(groups: Record<string, string | undefined>, message: string): EventPayload | null;
  dialectId?: DialectId;
}

/** Standard anchored-regex rule. */
export function regexRule(options: RegexRuleOptions): RecognizerRule {
  const { ruleId, family, frequencyRank, regex, build } = options;
  const source = regex.source;
  if (!source.startsWith("^") || !source.endsWith("$")) {
    throw new Error(`rule ${ruleId}: regex must be anchored ^…$ (LOG_FORMAT_SPEC.md §preamble)`);
  }
  return {
    ruleId,
    family,
    frequencyRank,
    dialectId: options.dialectId ?? DIALECT_EQL_BETA_2026_07,
    match(message) {
      const result = regex.exec(message);
      if (result === null) return null;
      return build(result.groups ?? {}, message);
    },
  };
}

interface ExactRuleOptions {
  ruleId: string;
  family: string;
  frequencyRank: number;
  /** Exact message strings — every entry is a captured corpus line. */
  entries: readonly string[];
  build(message: string): EventPayload;
  dialectId?: DialectId;
}

/**
 * Exact-string dictionary rule (O(1) set lookup). Used where the wording is a
 * closed set (system/UI messages, self spell emotes) — semantically equivalent
 * to one fully-escaped anchored regex per entry, without the scan cost.
 */
export function exactRule(options: ExactRuleOptions): RecognizerRule {
  const set = new Set(options.entries);
  return {
    ruleId: options.ruleId,
    family: options.family,
    frequencyRank: options.frequencyRank,
    dialectId: options.dialectId ?? DIALECT_EQL_BETA_2026_07,
    match(message) {
      return set.has(message) ? options.build(message) : null;
    },
  };
}
