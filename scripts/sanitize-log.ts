#!/usr/bin/env node
/**
 * Anonymize an EQL log excerpt for use as a public fixture.
 * Replaces supplied character/pet names with Playerone/Petone... and the log owner with "Youchar".
 * Keeps mob/spell/zone/item names, numbers, and structure EXACTLY as-is (fixture policy, CONTRIBUTING.md).
 * Usage: node sanitize-log.ts input.txt --players Alice,Bob --pets Fido > fixture.txt
 */
import fs from "node:fs";
const args = process.argv.slice(2);
const file = args[0];
if (!file) { console.error("usage: sanitize-log.ts input.txt --players A,B --pets C"); process.exit(2); }
const get = (flag: string) => (args.includes(flag) ? (args[args.indexOf(flag) + 1] ?? "").split(",").filter(Boolean) : []);
const players = get("--players"), pets = get("--pets");
let text = fs.readFileSync(file, "utf8");
const ORDINALS = ["one","two","three","four","five","six","seven","eight","nine","ten"];
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const replaceAll = (names: string[], prefix: string) => {
  // Longest-first so overlapping names (one a prefix of another) never
  // partially rewrite each other; labels keep the CLI argument order.
  // \w lookarounds instead of \b: names may end in non-word characters,
  // where \b silently fails to match.
  const labeled = names.map((n, i) => [n, `${prefix}${ORDINALS[i] ?? i}`] as const);
  for (const [n, label] of [...labeled].sort((a, b) => b[0].length - a[0].length)) {
    text = text.replace(new RegExp(`(?<!\\w)${escapeRegExp(n)}(?!\\w)`, "g"), label);
  }
};
replaceAll(players, "Player");
replaceAll(pets, "Pet");
process.stdout.write(text);
