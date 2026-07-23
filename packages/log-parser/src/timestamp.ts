/**
 * Fixed-offset timestamp slicing (LOG_FORMAT_SPEC.md §2, ARCHITECTURE.md ADR-2).
 *
 * Every EQL line starts with a fixed-width asctime prefix:
 *
 *   `[Day Mon DD HH:MM:SS YYYY] <message>`
 *
 * `[` + 24-char asctime + `] ` — so the timestamp is `line.slice(1, 25)` and the
 * message body starts at offset 27. No regex on the hot path.
 *
 * Determinism note (ARCHITECTURE.md §1.3): the stamp is *local time with no zone
 * marker*. We intentionally interpret it as UTC so that the same bytes produce
 * the same `ts` on every machine; consumers that need wall-clock alignment own
 * the zone shift. This is a documented policy, not an oversight.
 */

/** Offset of the first message-body character in a well-formed line. */
export const MESSAGE_OFFSET = 27;

const MONTHS: Readonly<Record<string, number>> = Object.freeze({
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
});

const DAY_NAMES = new Set(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);

function toInt(text: string): number {
  // Tolerates the (unverified) space-padded day form "Jul  5" via trim.
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return Number.NaN;
  return Number.parseInt(trimmed, 10);
}

/**
 * Parse the fixed-width `[Day Mon DD HH:MM:SS YYYY] ` prefix.
 *
 * @returns epoch milliseconds, or `null` when the prefix is malformed
 * (missing bracket, unknown month, out-of-range fields, short line, ...).
 * Malformed lines become `raw_unknown` upstream — never a guess.
 */
export function parseTimestamp(line: string): number | null {
  // Shape: [Fri Jul 10 17:14:01 2026]<space>
  if (line.length < MESSAGE_OFFSET || line.charCodeAt(0) !== 0x5b /* [ */) return null;
  if (line[25] !== "]" || line[26] !== " ") return null;
  const dayName = line.slice(1, 4);
  if (!DAY_NAMES.has(dayName)) return null;
  if (line[4] !== " " || line[8] !== " " || line[11] !== " " || line[20] !== " ") return null;
  const month = MONTHS[line.slice(5, 8)];
  if (month === undefined) return null;
  const day = toInt(line.slice(9, 11));
  const hour = toInt(line.slice(12, 14));
  const minute = toInt(line.slice(15, 17));
  const second = toInt(line.slice(18, 20));
  const year = toInt(line.slice(21, 25));
  if (
    Number.isNaN(day) ||
    Number.isNaN(hour) ||
    Number.isNaN(minute) ||
    Number.isNaN(second) ||
    Number.isNaN(year)
  ) {
    return null;
  }
  if (line[14] !== ":" || line[17] !== ":") return null;
  if (day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const ts = Date.UTC(year, month, day, hour, minute, second);
  // Reject silent Date rollover (e.g. Feb 30 -> Mar 2).
  const check = new Date(ts);
  if (check.getUTCDate() !== day || check.getUTCMonth() !== month) return null;
  return ts;
}

/** Message body of a well-formed line (call only after `parseTimestamp` succeeded). */
export function messageBody(line: string): string {
  return line.slice(MESSAGE_OFFSET);
}
