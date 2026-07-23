/**
 * Coin-list parsing (LOG_FORMAT_SPEC.md §4.14, DATA_MODEL.md §7).
 *
 * Prices/coin drops are comma/`and`-joined lists of `<n> <denomination>` with
 * only nonzero denominations present, e.g.
 * "3 platinum, 2 gold, 1 silver and 4 copper". Stored lossless as integer
 * copper: 1p=1000c, 1g=100c, 1s=10c.
 */

export const COPPER_PER: Readonly<Record<string, number>> = Object.freeze({
  platinum: 1000,
  gold: 100,
  silver: 10,
  copper: 1,
});

/** Reusable regex fragment matching a full coin list (no capture groups). */
export const COIN_LIST_PATTERN = "\\d+ (?:platinum|gold|silver|copper)(?:(?:, | and )\\d+ (?:platinum|gold|silver|copper))*";

/**
 * Merchant-sale lines join denominations with single spaces instead
 * ("4 silver 5 copper" — corpus-verified): a separate reusable fragment.
 */
export const COIN_LIST_SPACE_PATTERN = "\\d+ (?:platinum|gold|silver|copper)(?: \\d+ (?:platinum|gold|silver|copper))*";

const PART = /^(\d+) (platinum|gold|silver|copper)$/;

/** "1 silver and 8 copper" -> 18; `null` when the text is not a coin list. */
export function coinsToCopper(text: string): number | null {
  const parts = text.split(/, | and /).flatMap((chunk) => {
    // Space-joined merchant form: "4 silver 5 copper" -> ["4 silver", "5 copper"].
    const spaced = chunk.match(/\d+ [a-z]+/g);
    return spaced ?? [chunk];
  });
  let total = 0;
  for (const part of parts) {
    const match = PART.exec(part);
    if (match === null) return null;
    const amount = match[1];
    const denom = match[2];
    if (amount === undefined || denom === undefined) return null;
    const per = COPPER_PER[denom];
    if (per === undefined) return null;
    total += Number.parseInt(amount, 10) * per;
  }
  return total;
}
