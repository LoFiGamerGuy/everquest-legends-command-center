import { describe, expect, it } from "vitest";

import { MESSAGE_OFFSET, messageBody, parseTimestamp } from "../src/index.js";

describe("parseTimestamp (fixed-offset slice, spec §2)", () => {
  it("parses the standard prefix as UTC epoch ms", () => {
    expect(parseTimestamp("[Fri Jul 10 17:14:01 2026] You are stunned!")).toBe(
      Date.UTC(2026, 6, 10, 17, 14, 1),
    );
  });

  it("keeps the message body at the fixed offset 27", () => {
    const line = "[Fri Jul 10 17:14:01 2026] Auto attack is on.";
    expect(line[MESSAGE_OFFSET - 2]).toBe("]");
    expect(messageBody(line)).toBe("Auto attack is on.");
  });

  it("tolerates the (unverified) space-padded day form", () => {
    expect(parseTimestamp("[Sun Jul  5 01:02:03 2026] x")).toBe(Date.UTC(2026, 6, 5, 1, 2, 3));
  });

  it("rejects malformed prefixes -> null (raw_unknown upstream)", () => {
    expect(parseTimestamp("no timestamp at all")).toBeNull();
    expect(parseTimestamp("")).toBeNull();
    expect(parseTimestamp("[Xxx Jul 10 17:14:01 2026] x")).toBeNull();
    expect(parseTimestamp("[Fri Xyz 10 17:14:01 2026] x")).toBeNull();
    expect(parseTimestamp("[Fri Jul 10 17:14:01 2026]x missing space")).toBeNull();
    expect(parseTimestamp("[Fri Jul 10 25:14:01 2026] hour out of range")).toBeNull();
    expect(parseTimestamp("[Fri Jul 10 17:14 2026] too short prefix pad")).toBeNull();
    expect(parseTimestamp("[Fri Feb 30 10:00:00 2026] date rollover")).toBeNull();
  });
});
