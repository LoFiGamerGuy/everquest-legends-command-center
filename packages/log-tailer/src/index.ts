/**
 * @eqlcc/log-tailer — log discovery + resumable byte-offset tailing.
 *
 * Pure TypeScript over Node builtins (`node:fs`, `node:path`,
 * `node:events`). Never persists offsets; see README for the
 * tailer/database watermark boundary.
 */

export { discoverLogFiles, parseLogFileName, type DiscoveredLogFile } from "./discovery.js";
export { decodeLine, type LogEncoding } from "./encoding.js";
export {
  LogTailer,
  type LineBatch,
  type LogTailerOptions,
  type TailedLine,
  type TruncationEvent,
} from "./tailer.js";
export {
  TailManager,
  type ManagedLineBatch,
  type ManagedTruncationEvent,
  type TailManagerOptions,
} from "./multi.js";
