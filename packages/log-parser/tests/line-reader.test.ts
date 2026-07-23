import { describe, expect, it } from "vitest";

import { LineSplitter, splitLines } from "../src/index.js";

describe("LineSplitter", () => {
  it("splits CRLF lines and counts terminator bytes in offsets", () => {
    const lines = splitLines("abc\r\ndefg\r\n");
    expect(lines).toEqual([
      { raw: "abc", byteOffset: 0, lineNo: 1 },
      { raw: "defg", byteOffset: 5, lineNo: 2 },
    ]);
  });

  it("tolerates bare LF", () => {
    const lines = splitLines("abc\ndef\n");
    expect(lines.map((l) => l.byteOffset)).toEqual([0, 4]);
  });

  it("buffers partial lines across feeds; watermark only advances on complete lines", () => {
    const splitter = new LineSplitter();
    expect(splitter.feed("[Fri Jul 10 17:14:01 2026] Auto att")).toEqual([]);
    expect(splitter.watermark).toBe(0);
    const lines = splitter.feed("ack is on.\r\nnext");
    expect(lines).toEqual([
      { raw: "[Fri Jul 10 17:14:01 2026] Auto attack is on.", byteOffset: 0, lineNo: 1 },
    ]);
    expect(splitter.watermark).toBe(47); // 45 chars + \r\n
    expect(splitter.end()).toEqual([{ raw: "next", byteOffset: 47, lineNo: 2 }]);
  });

  it("emits a trailing unterminated line only on end()", () => {
    const lines = splitLines("a\r\nb");
    expect(lines).toEqual([
      { raw: "a", byteOffset: 0, lineNo: 1 },
      { raw: "b", byteOffset: 3, lineNo: 2 },
    ]);
  });

  it("resumes from a stored watermark", () => {
    const splitter = new LineSplitter(100, 11);
    expect(splitter.feed("xyz\n")).toEqual([{ raw: "xyz", byteOffset: 100, lineNo: 11 }]);
  });
});
