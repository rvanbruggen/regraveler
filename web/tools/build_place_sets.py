#!/usr/bin/env python3
"""Build data/place-sets/index.json: the example place sets the page offers to add.

Each set is a CSV file in web/data/place-sets/, in the Google My Maps layer export format
(WKT "POINT (lon lat)", name, description) or any CSV the Places tab reads (name and lat/lon
columns). The page can't list a folder on a static site, so this script lists the files, with
a title, the category every place of the set gets, and the number of places. Run it after
adding, replacing or removing a file:

    python3 web/tools/build_place_sets.py

Sets are listed by file name, so a prefix ("1-", "2-") sets the order; the rest of the name
picks the title and category from SETS below (else: the name, category "other"). Standard
library only.
"""
from __future__ import annotations

import csv
import io
import json
import re
import sys
from pathlib import Path

PLACE_SETS = Path(__file__).resolve().parent.parent / "data" / "place-sets"

# File name without the number prefix -> (title, category id; see DEFAULT_CATEGORIES in js/poi.js).
SETS = {
    "fritleeuwen": ("Fritleeuwen", "frituur"),
    "kroegtijgers": ("Kroegtijgers", "cafe"),
    "mybrevet-belfries": ("MyBrevet.cc – Belfries", "sight"),
    "mybrevet-castles": ("MyBrevet.cc – Castles", "sight"),
    "mybrevet-abbeys": ("MyBrevet.cc – Abbeys", "sight"),
}

POINT = re.compile(r"POINT\s*Z?\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)", re.IGNORECASE)


def count_places(text: str) -> int:
    """Rows with a position: a WKT point, or lat and lon columns."""
    rows = list(csv.reader(io.StringIO(text.lstrip("﻿"))))
    if not rows:
        return 0
    header = [h.strip().lower() for h in rows[0]]
    n = 0
    for row in rows[1:]:
        if not any(f.strip() for f in row):
            continue
        if "wkt" in header:
            if POINT.search(row[header.index("wkt")] if len(row) > header.index("wkt") else ""):
                n += 1
        elif "lat" in header and "lon" in header:
            try:
                float(row[header.index("lat")].replace(",", "."))
                float(row[header.index("lon")].replace(",", "."))
                n += 1
            except (IndexError, ValueError):
                pass
    return n


def describe(path: Path) -> dict:
    key = re.sub(r"^\d+-", "", path.stem).lower()
    title, category = SETS.get(key, (re.sub(r"^\d+-", "", path.stem), "other"))
    count = count_places(path.read_text(encoding="utf-8"))
    if not count:
        raise ValueError("no places with a position")
    return {"file": path.name, "title": title, "category": category, "count": count}


def order(path: Path):
    m = re.match(r"^(\d+)-", path.name)
    return (int(m.group(1)) if m else sys.maxsize, path.name)


def main() -> int:
    PLACE_SETS.mkdir(parents=True, exist_ok=True)
    sets, failed = [], 0
    for path in sorted(PLACE_SETS.glob("*.csv"), key=order):
        try:
            sets.append(describe(path))
            print(f"{path.name}: {sets[-1]['title']} ({sets[-1]['category']}), {sets[-1]['count']} places")
        except (OSError, UnicodeDecodeError, ValueError) as err:
            print(f"{path.name}: skipped ({err})", file=sys.stderr)
            failed += 1
    (PLACE_SETS / "index.json").write_text(json.dumps({"sets": sets}, indent=2, ensure_ascii=False) + "\n")
    print(f"{len(sets)} set(s) in {PLACE_SETS / 'index.json'}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
