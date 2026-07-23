/** Narrowing helpers for the `LogEvent` discriminated union. */

import type { EventOfType, EventType, LogEvent } from "./events.js";

/**
 * Single generic narrowing guard:
 * `if (isEventType(e, "melee_hit")) { e.amount ... }`.
 */
export function isEventType<K extends EventType>(
  event: LogEvent,
  type: K,
): event is EventOfType<K> {
  return event.type === type;
}

/**
 * Exhaustiveness helper for switches over `LogEvent["type"]`: a `default`
 * branch calling `assertNever(event)` fails to COMPILE if a union member is
 * unhandled, and throws at runtime if an unknown value slips through.
 */
export function assertNever(value: never, message = "Unexpected value"): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}
