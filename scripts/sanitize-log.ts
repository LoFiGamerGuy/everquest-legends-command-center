#!/usr/bin/env node
/**
 * Anonymize an EQL log excerpt for use as a public fixture.
 * Replaces supplied character/pet names with Playerone/Petone... and the log owner with "Youchar".
 * Keeps mob/spell/zone/item names, numbers, and structure EXACTLY as-is (fixture policy, CONTRIBUTING.md).
 * Usage: node sanitize-log.ts input.txt --players Vess,Vessilia --pets Lenann > fixture.txt
 */
const fs = require("node:fs");
const args = process.argv.slice(2);
const file = args[0];
const get = (flag: string) => (args.includes(flag) ? (args[args.indexOf(flag) + 1] ?? "").split(",").filter(Boolean) : []);
const players = get("--players"), pets = get("--pets");
let text = fs.readFileSync(file, "utf8");
const replaceAll = (names: string[], prefix: string) =>
  names.forEach((n, i) => { text = text.replace(new RegExp(`\\b${n}\\b`, "g"), `${prefix}${["one","two","three","four","five","six","seven","eight","nine","ten"][i] ?? i}`); });
replaceAll(players, "Player");
replaceAll(pets, "Pet");
process.stdout.write(text);
