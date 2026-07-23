/**
 * Line splitting with byte-offset provenance (ARCHITECTURE.md §5).
 *
 * The tailer streams raw bytes; this module turns them into complete lines that
 * carry `(byteOffset, lineNo)`. Only complete lines (terminated by `\n`,
 * tolerating `\r\n`) are emitted — trailing bytes stay buffered so a partial
 * write never splits a line (§5.3).
 *
 * Encoding: callers decode bytes as latin1 (one byte per char) so that string
 * indices equal byte offsets; EQL logs are ASCII/Windows-1252 in practice
 * (LOG_FORMAT_SPEC.md §1 open question). Offsets count raw bytes.
 */

export interface RawLine {
  /** Line content without its terminator. */
  raw: string;
  /** Offset of the line's first byte in the source file. */
  byteOffset: number;
  /** 1-based line number within the source file. */
  lineNo: number;
}

/** Incremental splitter: feed decoded chunks in file order, then `end()`. */
export class LineSplitter {
  private buffer = "";
  private offset: number;
  private lineNo: number;

  constructor(startOffset = 0, startLineNo = 1) {
    this.offset = startOffset;
    this.lineNo = startLineNo;
  }

  /** Bytes consumed into fully-emitted lines (the resume watermark candidate). */
  get watermark(): number {
    return this.offset;
  }

  feed(chunk: string): RawLine[] {
    this.buffer += chunk;
    const lines: RawLine[] = [];
    let start = 0;
    for (;;) {
      const nl = this.buffer.indexOf("\n", start);
      if (nl === -1) break;
      const terminated = nl + 1;
      let end = nl;
      if (end > start && this.buffer.charCodeAt(end - 1) === 0x0d /* \r */) end -= 1;
      lines.push({
        raw: this.buffer.slice(start, end),
        byteOffset: this.offset,
        lineNo: this.lineNo,
      });
      this.offset += terminated - start;
      this.lineNo += 1;
      start = terminated;
    }
    this.buffer = this.buffer.slice(start);
    return lines;
  }

  /** Flush a trailing unterminated line, if any (end of historical backfill). */
  end(): RawLine[] {
    if (this.buffer.length === 0) return [];
    const line: RawLine = {
      raw: this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer,
      byteOffset: this.offset,
      lineNo: this.lineNo,
    };
    this.offset += this.buffer.length;
    this.lineNo += 1;
    this.buffer = "";
    return [line];
  }
}

/** Split a whole decoded file into lines with offsets (backfill/CLI path). */
export function splitLines(text: string, startOffset = 0): RawLine[] {
  const splitter = new LineSplitter(startOffset);
  const lines = splitter.feed(text);
  lines.push(...splitter.end());
  return lines;
}
