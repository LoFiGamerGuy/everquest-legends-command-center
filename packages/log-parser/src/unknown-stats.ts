/**
 * Unknown-line diagnostics (ARCHITECTURE.md §7, DATA_MODEL `unknown_line_stats`).
 *
 * Unmatched lines are aggregated by *normalized shape* so users get a "top 20
 * unknown shapes" triage view they can paste into an issue as fixture
 * candidates:
 *   - digits            -> `#`
 *   - quoted strings    -> `'…'`
 *   - name-like tokens  -> token classes: capitalized words become `Name`
 *     (runs collapse), keeping sentence structure intact.
 *
 * Anonymization contract: the shape is a SHAREABLE, name-free string (it is the
 * drift/detect output surface). Capitalized (name-like) token runs are collapsed
 * to `Name` ANYWHERE in the line, INCLUDING the leading token — a leading player
 * name must never leak. A small whitelist of sentence openers that are never
 * player names (articles, `You`/`Your`) is kept verbatim for readability;
 * matching is exact-token, so `The` is kept but `Theresa` is anonymized.
 */

/** Capitalized sentence openers that are never player names — kept verbatim. */
const SHAPE_KEEP_OPENERS: ReadonlySet<string> = new Set([
  "A",
  "An",
  "The",
  "You",
  "Your",
  "YOU",
  "YOUR",
]);

export function normalizeShape(message: string): string {
  let shape = message;
  // Quoted payloads first (chat/emote text can contain anything).
  shape = shape.replace(/'.*'/s, "'…'");
  // Digits.
  shape = shape.replace(/\d+/g, "#");
  // Collapse runs of capitalized (name-like) tokens to `Name`, anywhere in the
  // line including the leading token. Whitelisted openers are peeled off and
  // kept; any remaining capitalized tokens in the run collapse to one `Name`.
  shape = shape.replace(
    /[A-Z][A-Za-z`'-]*(?:\s+[A-Z][A-Za-z`'-]*)*/g,
    (run) => {
      const tokens = run.split(/\s+/);
      let i = 0;
      while (i < tokens.length && SHAPE_KEEP_OPENERS.has(tokens[i] as string)) i += 1;
      if (i === tokens.length) return run; // entirely whitelisted openers
      return [...tokens.slice(0, i), "Name"].join(" ");
    },
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
