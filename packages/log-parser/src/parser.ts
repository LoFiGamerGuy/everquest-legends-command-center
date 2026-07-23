/**
 * Line -> LogEvent (ARCHITECTURE.md §3 stages 2–3).
 *
 * Deterministic and pure: same bytes in, same events out. Every event carries
 * full provenance (ts, raw, byteOffset, lineNo, logFileId, dialectId, ruleId).
 *
 * Malformed timestamp policy: the whole line becomes `raw_unknown`; `ts`
 * carries the last well-formed timestamp seen in this file (0 if none) so the
 * event still sorts near its neighbors. Documented, never guessed content.
 */

import type { LogEvent } from "@eqlcc/event-schema";
import { DIALECT_EQL_BETA_2026_07 } from "@eqlcc/event-schema";
import type { RawLine } from "./line-reader.js";
import { splitLines } from "./line-reader.js";
import { RecognizerRegistry } from "./registry.js";
import { MESSAGE_OFFSET, parseTimestamp } from "./timestamp.js";

export interface ParserOptions {
  logFileId: number;
  registry?: RecognizerRegistry;
}

export class LogParser {
  readonly registry: RecognizerRegistry;
  private readonly logFileId: number;
  private lastTs = 0;

  constructor(options: ParserOptions) {
    this.logFileId = options.logFileId;
    this.registry = options.registry ?? new RecognizerRegistry();
  }

  parseLine(line: RawLine): LogEvent {
    const { raw, byteOffset, lineNo } = line;
    const ts = parseTimestamp(raw);
    if (ts === null) {
      return {
        type: "raw_unknown",
        ts: this.lastTs,
        raw,
        byteOffset,
        lineNo,
        logFileId: this.logFileId,
        dialectId: DIALECT_EQL_BETA_2026_07,
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
        raw,
        byteOffset,
        lineNo,
        logFileId: this.logFileId,
        dialectId: DIALECT_EQL_BETA_2026_07,
        ruleId: null,
      };
    }
    return {
      ...recognition.payload,
      ts,
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
