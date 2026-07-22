#!/usr/bin/env python3
"""Classify an EQL install manifest (TSV: type,size,mtime,path) into discovery categories A-H.
Read-only analysis of a manifest file; never touches the game directory itself.
Categories: A user-generated readable; B config/structured; C localization/UI/resource metadata;
D executable/library metadata; E archive/container metadata; F undocumented binary/proprietary;
G encrypted/protected; H unknown.  F-H: metadata-only, research note, human approval before more.
Usage: classify-eql-files.py manifest.tsv > classified.tsv
"""
import sys, os, csv

RULES = [  # (category, predicate on (name, ext))
    ("A", lambda n, e: n.startswith("eqlog_") or n in ("dbg.txt", "debug.log", "log.txt") or e in (".log",)),
    ("A", lambda n, e: "_LO1" in n or n.startswith("UI_") or n == "_characters.ini"),  # per-character UI/layout
    ("B", lambda n, e: e in (".ini", ".cfg", ".json", ".yaml", ".yml", ".csv")),
    ("C", lambda n, e: e == ".txt"),   # zone asset/emitter/string lists observed as plaintext
    ("C", lambda n, e: e in (".xml", ".html")),
    ("D", lambda n, e: e in (".exe", ".dll", ".asi", ".pdb")),
    ("E", lambda n, e: e in (".zip", ".7z", ".pak")),   # .pak: identify only, no structural parsing
    ("F", lambda n, e: e in (".eqg", ".s3d", ".eff", ".zon", ".emt", ".edd", ".m3d", ".xmi", ".eal", ".wld", ".dat")),
    ("C", lambda n, e: e in (".mp3", ".wav", ".ogg", ".ico", ".bmp", ".png", ".jpg", ".tga", ".dds", ".pdf", ".doc")),
]

def classify(path):
    n = os.path.basename(path); e = os.path.splitext(n)[1].lower()
    for cat, pred in RULES:
        try:
            if pred(n, e): return cat
        except Exception: pass
    return "H"

def main(p):
    w = csv.writer(sys.stdout, delimiter="\t")
    for row in csv.reader(open(p, encoding="utf-8", errors="replace"), delimiter="\t"):
        if len(row) < 4 or row[0] != "f": continue
        w.writerow([classify(row[3]), *row])

if __name__ == "__main__":
    main(sys.argv[1])
