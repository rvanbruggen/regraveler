#!/usr/bin/env python3
"""Build data/seeds/index.json: the example route sets the page offers to load.

Each set is a rerouter zip in web/data/seeds/, made in the app with "Export set…" (select
the routes in the library first). The page can't list a folder on a static site, so this
script lists the zips, with the title and description stored in each zip and the number of
routes and kilometres. Run it after adding, replacing or removing a zip:

    python3 web/tools/build_seeds.py

Sets are listed by file name, so a prefix ("1-", "2-") sets the order. Standard library only.
"""
from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

SEEDS = Path(__file__).resolve().parent.parent / "data" / "seeds"


def describe(path: Path) -> dict:
    with zipfile.ZipFile(path) as z:
        manifest = json.loads(z.read("library.json"))
    if manifest.get("format") != "rerouter-backup":
        raise ValueError("not a rerouter zip")
    routes = manifest.get("routes") or []
    return {
        "file": path.name,
        "title": manifest.get("title") or path.stem,
        "description": manifest.get("description"),
        "routes": len(routes),
        "km": round(sum(r.get("distance_km") or 0 for r in routes), 1),
        "activities": sorted({r.get("activity") for r in routes if r.get("activity")}),
    }


def main() -> int:
    SEEDS.mkdir(parents=True, exist_ok=True)
    seeds, failed = [], 0
    for path in sorted(SEEDS.glob("*.zip")):
        try:
            seeds.append(describe(path))
            print(f"{path.name}: {seeds[-1]['title']}, {seeds[-1]['routes']} routes")
        except (KeyError, ValueError, zipfile.BadZipFile) as err:
            print(f"{path.name}: skipped ({err})", file=sys.stderr)
            failed += 1
    (SEEDS / "index.json").write_text(json.dumps({"seeds": seeds}, indent=2, ensure_ascii=False) + "\n")
    print(f"{len(seeds)} set(s) in {SEEDS / 'index.json'}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
