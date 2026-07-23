import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverLogFiles, parseLogFileName } from "../src/index.js";
import { makeTmpDir, rmDirs } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => rmDirs(dirs));

describe("parseLogFileName", () => {
  it("parses character and server from eqlog_<Character>_<server>.txt", () => {
    expect(parseLogFileName("eqlog_Playerone_erudin.txt")).toEqual({
      character: "Playerone",
      server: "erudin",
    });
  });

  it("is case-insensitive on prefix/suffix and preserves part casing", () => {
    expect(parseLogFileName("EQLOG_Playertwo_Freeport.TXT")).toEqual({
      character: "Playertwo",
      server: "Freeport",
    });
  });

  it("allows underscores in the server part (character names cannot contain them)", () => {
    expect(parseLogFileName("eqlog_Playerone_test_server.txt")).toEqual({
      character: "Playerone",
      server: "test_server",
    });
  });

  it("rejects unrelated or malformed names", () => {
    expect(parseLogFileName("dbg.txt")).toBeNull();
    expect(parseLogFileName("eqlog_Playerone.txt")).toBeNull(); // no server
    expect(parseLogFileName("eqlog__erudin.txt")).toBeNull(); // empty character
    expect(parseLogFileName("eqlog_Playerone_erudin.txt.bak")).toBeNull();
    expect(parseLogFileName("notes-eqlog_Playerone_erudin.txt")).toBeNull();
    expect(parseLogFileName("eqlog_Playerone_erudin.log")).toBeNull();
  });
});

describe("discoverLogFiles", () => {
  it("returns metadata for log files and tolerates unrelated entries", () => {
    const dir = makeTmpDir(dirs);
    fs.writeFileSync(path.join(dir, "eqlog_Playerone_erudin.txt"), "hello\n");
    fs.writeFileSync(path.join(dir, "dbg.txt"), "noise");
    fs.writeFileSync(path.join(dir, "eqlog_bad.txt"), "noise");
    // A directory whose *name* matches must be skipped, not stat-crashed on.
    fs.mkdirSync(path.join(dir, "eqlog_Fake_dir.txt"));

    const found = discoverLogFiles(dir);
    expect(found).toHaveLength(1);
    const file = found[0]!;
    expect(file.path).toBe(path.join(dir, "eqlog_Playerone_erudin.txt"));
    expect(file.fileName).toBe("eqlog_Playerone_erudin.txt");
    expect(file.character).toBe("Playerone");
    expect(file.server).toBe("erudin");
    expect(file.sizeBytes).toBe(6);
    expect(file.mtimeMs).toBeGreaterThan(0);
  });

  it("orders results most-recently-modified first", () => {
    const dir = makeTmpDir(dirs);
    const old = path.join(dir, "eqlog_Playerone_erudin.txt");
    const mid = path.join(dir, "eqlog_Playertwo_freeport.txt");
    const fresh = path.join(dir, "eqlog_Playerthree_neriak.txt");
    for (const p of [old, mid, fresh]) fs.writeFileSync(p, "x\n");
    const now = Date.now() / 1000;
    fs.utimesSync(old, now - 300, now - 300);
    fs.utimesSync(mid, now - 200, now - 200);
    fs.utimesSync(fresh, now - 100, now - 100);

    expect(discoverLogFiles(dir).map((f) => f.character)).toEqual([
      "Playerthree",
      "Playertwo",
      "Playerone",
    ]);
  });

  it("throws when the Logs directory itself is missing (caller error)", () => {
    const dir = makeTmpDir(dirs);
    expect(() => discoverLogFiles(path.join(dir, "does-not-exist"))).toThrow();
  });
});
