#!/usr/bin/env python3
"""Owner-run, local-only keyword indexer over READABLE PLAINTEXT files from a classified manifest.
Reads only category A/B/C plaintext files. Never parses proprietary containers (F/G), never
modifies anything. Output stays local (data/ is gitignored); results are candidates, NOT
authoritative game data - correlate with logs/screenshots before trusting.
Usage: search-readable-resources.py classified.tsv /path/to/root > candidates.tsv
"""
import sys, csv, re

TOPICS = {
    "aa": re.compile(r"\b(alternate advancement|ability point|rank [IVX0-9]+)\b", re.I),
    "spell_song": re.compile(r"\b(mana cost|casting time|spell|song|invocation|stance)\b", re.I),
    "class_race": re.compile(r"\b(warrior|cleric|necromancer|shaman|enchanter|berserker|human|erudite|troll|ogre|barbarian)\b", re.I),
    "skill": re.compile(r"\b(skill|bind wound|specialize [a-z]+)\b", re.I),
    "item": re.compile(r"\b(platinum|weight|slot|AC:|DMG:|delay)\b", re.I),
    "zone_npc": re.compile(r"\b(zone|spawn|merchant|guard|GM)\b", re.I),
    "ui_command": re.compile(r"(^/[a-z]+\b|\bhotbar|\bwindow\b)", re.I),
    "log_template": re.compile(r"%[0-9TS]|\{\d+\}", re.I),
    "pet": re.compile(r"\b(pet|summon|charm|Master)\b", re.I),
}
MAX_BYTES = 5_000_000

def main(classified, root):
    w = csv.writer(sys.stdout, delimiter="\t")
    w.writerow(["path", "topic", "line_no", "excerpt"])
    for row in csv.reader(open(classified, encoding="utf-8", errors="replace"), delimiter="\t"):
        cat, _t, size, _m, path = row[0], *row[1:5]
        if cat not in "ABC" or int(size) > MAX_BYTES: continue
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                for i, line in enumerate(f, 1):
                    if "\x00" in line: break  # not actually plaintext; skip file
                    for topic, rx in TOPICS.items():
                        if rx.search(line):
                            w.writerow([path, topic, i, line.strip()[:200]]); break
        except OSError: continue

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
