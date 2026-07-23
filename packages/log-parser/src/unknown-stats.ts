/**
 * Unknown-line diagnostics (ARCHITECTURE.md §7, DATA_MODEL `unknown_line_stats`).
 *
 * Unmatched lines are aggregated by *normalized shape* so users get a "top 20
 * unknown shapes" triage view they can paste into an issue as fixture
 * candidates:
 *   - digits            -> `#`
 *   - quoted strings    -> `'…'`
 *   - name-like tokens  -> token classes: capitalized words after the first
 *     token become `Name` (runs collapse), keeping sentence structure intact.
 */

export function normalizeShape(message: string): string {
  let shape = message;
  // Quoted payloads first (chat/emote text can contain anything).
  shape = shape.replace(/'.*'/s, "'…'");
  // Digits.
  shape = shape.replace(/\d+/g, "#");
  // Name-like token runs (capitalized, possibly with ` or ' or -) anywhere
  // except the leading token; leading position only when followed by a
  // lowercase verb-ish token is left to keep shapes readable.
  shape = shape.replace(
    /(?<=\s)((?:[A-Z][A-Za-z`'-]*)(?:\s+[A-Z][A-Za-z`'-]*)*)/g,
    "Name",
  );
  return shape;
}

export interface UnknownShape {
  shape: string;
  count: number;
  /** First raw message body observed for this shape (local diagnostics only). */
  firstExample: string;
  firstLineNo: number;
}

/** Aggregates unmatched message bodies by normalized shape. */
export class UnknownStats {
  private readonly shapes = new Map<string, UnknownShape>();
  private total_ = 0;

  get total(): number {
    return this.total_;
  }

  get distinctShapes(): number {
    return this.shapes.size;
  }

  add(message: string, lineNo: number): void {
    this.total_ += 1;
    const shape = normalizeShape(message);
    const existing = this.shapes.get(shape);
    if (existing === undefined) {
      this.shapes.set(shape, { shape, count: 1, firstExample: message, firstLineNo: lineNo });
    } else {
      existing.count += 1;
    }
  }

  /** Top-N shapes by count (ties: first-seen order). */
  top(n: number): UnknownShape[] {
    return [...this.shapes.values()].sort((a, b) => b.count - a.count).slice(0, n);
  }
}
