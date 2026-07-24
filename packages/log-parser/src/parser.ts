/**
 * Line -> LogEvent (ARCHITECTURE.md §3 stages 2–3).
 *
 * Deterministic and pure: same bytes in, same events out. Every event carries
 * full provenance (ts, raw, byteOffset, lineNo, logFileId, dialectId, ruleId).
 *
 * Malformed timestamp policy: the whole line becomes `raw_unknown`; `ts`
 * carries the last well-formed timestamp seen in this file (0 if none) so the
 * event still sorts near its neighbors. Documented, never guessed content.
 *
 * Ordering contract: `ts` is second-resolution, so the parser assigns a
 * per-file monotonic `seq` (1-based, every emitted event, including
 * raw_unknown) — `(logFileId, seq)` is the canonical total order. On tailer
 * resume pass `startSeq` (persisted with the byte-offset watermark in the same
 * transaction, DATA_MODEL.md §2).
 */

import type { DialectId, LogEvent } from "@eqlcc/event-schema";
import { DIALECT_EQL_BETA_2026_07 } from "@eqlcc/event-schema";
import type { RawLine } from "./line-reader.js";
import { splitLines } from "./line-reader.js";
import { RecognizerRegistry } from "./registry.js";
import { MESSAGE_OFFSET, parseTimestamp } from "./timestamp.js";

export interface ParserOptions {
  logFileId: number;
  registry?: RecognizerRegistry;
  /** Resume value: `seq` of the last previously-emitted event (default 0). */
  startSeq?: number;
  /**
   * Dialect stamped on `raw_unknown`/malformed-timestamp fallthrough events
   * (recognized events already carry their rule's dialectId). Defaults to
   * `DIALECT_EQL_BETA_2026_07` so existing single-dialect output is unchanged;
   * set it when parsing under a non-beta dialect so its unknowns roll up to the
   * right dialect (LAUNCH_DIALECT_READINESS.md — per-dialect diagnostics).
   */
  dialectId?: DialectId;
}

export class LogParser {
  readonly registry: RecognizerRegistry;
  private readonly logFileId: number;
  private readonly dialectId: DialectId;
  private lastTs = 0;
  private seq: number;

  constructor(options: ParserOptions) {
    this.logFileId = options.logFileId;
    this.registry = options.registry ?? new RecognizerRegistry();
    this.seq = options.startSeq ?? 0;
    this.dialectId = options.dialectId ?? DIALECT_EQL_BETA_2026_07;
  }

  parseLine(line: RawLine): LogEvent {
    const { raw, byteOffset, lineNo } = line;
    const seq = ++this.seq;
    const ts = parseTimestamp(raw);
    if (ts === null) {
      return {
        type: "raw_unknown",
        ts: this.lastTs,
        seq,
        raw,
        byteOffset,
        lineNo,
        logFileId: this.logFileId,
        dialectId: this.dialectId,
        ruleId: null,
      };
    }
    this.lastTs = ts;
    const message = raw.slice(MESSAGE_OFFSET);
    const recognition = this.registry.recognize(message);
    if (recognition === null) {
      return {
        type: "raw_unknown",
        ts,
        seq,
        raw,
        byteOffset,
        lineNo,
        logFileId: this.logFileId,
        dialectId: this.dialectId,
        ruleId: null,
      };
    }
    return {
      ...recognition.payload,
      ts,
      seq,
      raw,
      byteOffset,
      lineNo,
      logFileId: this.logFileId,
      dialectId: recognition.rule.dialectId,
      ruleId: recognition.rule.ruleId,
    } as LogEvent;
  }

  /** Parse a whole decoded file (latin1: 1 char = 1 byte; offsets = bytes). */
  parseText(text: string, startOffset = 0): LogEvent[] {
    return splitLines(text, startOffset).map((line) => this.parseLine(line));
  }
}
