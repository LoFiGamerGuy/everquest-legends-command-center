/**
 * Byte → string decoding for log lines (ARCHITECTURE.md §5.6).
 *
 * Classic EQ logs are Windows-1252, not UTF-8 (EQL itself is UNVERIFIED — see
 * LOG_FORMAT_SPEC.md open questions), so the default decoder is a lossless
 * Windows-1252 mapping. Byte offsets always count **raw bytes**; decoding
 * happens only after slicing, so the choice of encoding never affects offsets.
 *
 * Implemented by hand because this package may use Node builtins only.
 * Windows-1252 equals Latin-1 except for 0x80–0x9F; the five bytes that are
 * undefined in Windows-1252 (0x81, 0x8D, 0x8F, 0x90, 0x9D) fall back to their
 * own code point, so decoding is total and lossless.
 */

/** Supported log encodings. */
export type LogEncoding = "windows-1252" | "utf-8";

/** Windows-1252 code points for bytes 0x80–0x9F. */
// prettier-ignore
const CP1252_80_9F: readonly number[] = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

function decodeWindows1252(bytes: Uint8Array): string {
  const codePoints = new Array<number>(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number; // in-bounds by construction
    codePoints[i] = b >= 0x80 && b <= 0x9f ? (CP1252_80_9F[b - 0x80] as number) : b;
  }
  // Chunked to stay under engine argument-count limits for long lines.
  let out = "";
  for (let i = 0; i < codePoints.length; i += 4096) {
    out += String.fromCharCode(...codePoints.slice(i, i + 4096));
  }
  return out;
}

/** Decode a raw byte slice (one line, terminator already stripped). */
export function decodeLine(bytes: Uint8Array, encoding: LogEncoding): string {
  if (encoding === "utf-8") {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
  }
  return decodeWindows1252(bytes);
}
