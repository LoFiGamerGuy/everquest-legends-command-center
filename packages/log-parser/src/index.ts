/**
 * @eqlcc/log-parser — pure-TS parser core (ARCHITECTURE.md §2–§3).
 * Depends only on @eqlcc/event-schema; runs in Node, Web Workers, anywhere.
 */

export { LineSplitter, splitLines } from "./line-reader.js";
export type { RawLine } from "./line-reader.js";
export { MESSAGE_OFFSET, messageBody, parseTimestamp } from "./timestamp.js";
export { COIN_LIST_PATTERN, COPPER_PER, coinsToCopper } from "./coins.js";
export { exactRule, regexRule } from "./rule.js";
export type { EventPayload, RecognizerRule } from "./rule.js";
export { RecognizerRegistry, allRules } from "./registry.js";
export type { Recognition } from "./registry.js";
export { LogParser } from "./parser.js";
export type { ParserOptions } from "./parser.js";
export { UnknownStats, normalizeShape } from "./unknown-stats.js";
export type { UnknownShape } from "./unknown-stats.js";
// Plural dialects, detection, drift, benchmark (LAUNCH_DIALECT_READINESS.md).
export { DialectRegistry, createDefaultDialectRegistry } from "./dialect.js";
export type { Dialect, DialectDefinition, DialectBaseline } from "./dialect.js";
export {
  detectDialect,
  detectExplicitMarker,
  sampleForDetection,
  DRIFT_ALERT_RATE,
  UNKNOWN_DIALECT,
} from "./detect.js";
export type { DialectDetection, DetectDialectOptions, SampleOptions } from "./detect.js";
export { driftReport, FAMILY_DROP_THRESHOLD } from "./drift.js";
export type { DriftReport, FamilyDrift, DriftReportOptions, AnonymizedShape } from "./drift.js";
export { analyzeLines, benchmark, BENCHMARK_MAX_UNMATCHED_RATE } from "./benchmark.js";
export type { RunStats, BenchmarkResult } from "./benchmark.js";
export { BETA_BASELINE, BETA_FAMILY_COUNTS, sharesFromCounts } from "./baselines/eql-beta-2026-07.js";
export {
  EntityResolver,
  ATTRIBUTION_MIN_CONFIDENCE,
  parseLogFileName,
  GENERATED_PET_NAME,
  looksLikeGeneratedPetName,
} from "./resolver/index.js";
export type {
  EntityResolverOptions,
  LinkingEvidenceType,
  Attribution,
  ClassificationSource,
  ConflictRecord,
  EntityRecord,
  EvidenceRow,
  OwnerIdentity,
  OwnerLink,
  ResolvedEntity,
  ResolverSnapshot,
  SignalMeta,
} from "./resolver/index.js";
export { MELEE_VERBS_FIRST, MELEE_VERBS_THIRD, normalizeMissOutcome } from "./recognizers/melee.js";
export { SELF_SPELL_EMOTES, SUBJECT_EMOTE_SUFFIXES } from "./recognizers/emote-data.js";
export { SYSTEM_EXACT_MESSAGES } from "./recognizers/system-data.js";
