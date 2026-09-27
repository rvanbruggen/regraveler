#!/usr/bin/env python3
"""Build the trimmed place-name data (data/places/) from GeoNames country dumps.

GeoNames (https://download.geonames.org/export/dump/, CC BY 4.0): for each country the
places dump and the alternate names dump. Kept: towns and villages (with population) and
landmarks worth putting in a route name (forests, heaths, hills, parks, lakes, castles,
abbeys). Names are local: in the language of the country, or in Belgium of the region, where
GeoNames has one (--languages): Köln, Paris, Milano and București rather than the English
Cologne, Paris, Milan and Bucharest; in Flanders and Brussels Dutch (Zoniënwoud, not Forêt de
Soignes), in Wallonia French (Liège). Luxembourg keeps GeoNames' own (official) names.

The output is split into 1 x 1 degree tiles, so the browser only loads the area around a
route: data/places/<lat>_<lon>.json, plus data/places/index.json listing the tiles.

    python3 web/tools/build_places.py [--countries BE,NL,LU,DE,FR,IT,RO] [--cache DIR]
                                      [--languages BE=VLG:nl/BRU:nl/WAL:fr,NL=nl,...]

A language per country, or per first-level region ("VLG:nl/WAL:fr", GeoNames admin1 codes).
Places without a language (a country or region not listed, e.g. Luxembourg) keep the name
GeoNames lists first.

Standard library only. Downloads are cached in --cache (default: ./.geonames-cache).
"""
from __future__ import annotations

import argparse
import io
import json
import math
import urllib.request
import zipfile
from pathlib import Path

BASE_URL = "https://download.geonames.org/export/dump"
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "places"

TOWN_CODES = {"PPL", "PPLA", "PPLA2", "PPLA3", "PPLA4", "PPLC", "PPLG", "PPLS", "PPLF", "PPLL"}
# Must match LANDMARK_CODES in js/places.js.
LANDMARK_CODES = {
    "FRST", "FRSTF", "HTH", "PRK", "RESN", "RESF", "HLL", "HLLS", "MT", "LK", "LKS", "RSV",
    "CSTL", "MSTY", "HSTS",
}
# Landmarks whose single GeoNames point lies in another language region than most of the
# landmark: {geonameid: local name}. The Sonian Forest is ~56 % in Flanders, 38 % in Brussels
# and 6 % in Wallonia, but its point is in Wallonia.
NAME_OVERRIDES = {2786422: "Zoniënwoud"}

_FRENCH_START = ("forêt", "foret", "bois", "château", "chateau", "abbaye", "parc", "lac", "étang", "mont ")
_DUTCH_END = ("woud", "bos", "bossen", "kasteel", "abdij", "park", "meer", "vijver", "berg", "heide")


def fetch(cache: Path, url: str, target: Path, member: str) -> None:
    if target.exists():
        return
    print(f"downloading {url}")
    with urllib.request.urlopen(url, timeout=600) as resp:
        data = resp.read()
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        target.write_bytes(zf.read(member))


def preferred_names(path: Path, lang: str, wanted: set[int]):
    """(geonameid -> name in `lang`, geonameid -> alternates without a language code)."""
    best: dict[int, tuple[int, str]] = {}
    untagged: dict[int, list[str]] = {}
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            f = line.rstrip("\n").split("\t")
            if len(f) < 4:
                continue
            gid = int(f[1])
            if gid not in wanted:
                continue
            if f[2] == "":
                untagged.setdefault(gid, []).append(f[3])
                continue
            if f[2] != lang:
                continue
            short, colloquial, historic = (f[5:8] + ["", "", ""])[:3] if len(f) > 5 else ("", "", "")
            if short == "1" or colloquial == "1" or historic == "1":
                continue
            rank = 0 if (len(f) > 4 and f[4] == "1") else 1
            if gid not in best or rank < best[gid][0]:
                best[gid] = (rank, f[3])
    return {gid: name for gid, (_, name) in best.items()}, untagged


def display_name(gid, name, local, untagged, lang):
    if gid in NAME_OVERRIDES:
        return NAME_OVERRIDES[gid]
    if gid in local:
        return local[gid]
    if lang == "nl" and name.lower().startswith(_FRENCH_START):
        for alt in untagged.get(gid, []):
            if alt.lower().endswith(_DUTCH_END) and not alt.lower().startswith(_FRENCH_START):
                return alt
    return name


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--countries", default="BE,NL,LU,DE,FR,IT,RO")
    ap.add_argument("--cache", default=str(ROOT / ".geonames-cache"))
    ap.add_argument("--languages", default="BE=VLG:nl/BRU:nl/WAL:fr,NL=nl,DE=de,FR=fr,IT=it,RO=ro",
                    help="name language per country (or per region), e.g. IT=it,BE=VLG:nl/WAL:fr")
    args = ap.parse_args()
    cache = Path(args.cache)
    cache.mkdir(parents=True, exist_ok=True)
    countries = [c.strip().upper() for c in args.countries.split(",") if c.strip()]
    # {country: {admin1 code or "*": language}}
    languages: dict[str, dict[str, str]] = {}
    for item in args.languages.split(","):
        if "=" not in item:
            continue
        cc, spec = item.split("=", 1)
        regions = {}
        for part in spec.split("/"):
            region, _, lang = part.rpartition(":")
            regions[region.strip().upper() or "*"] = lang.strip().lower()
        languages[cc.strip().upper()] = regions

    tiles: dict[str, list] = {}
    total = 0
    order = 0
    for cc in countries:
        fetch(cache, f"{BASE_URL}/{cc}.zip", cache / f"{cc}.txt", f"{cc}.txt")
        fetch(cache, f"{BASE_URL}/alternatenames/{cc}.zip", cache / f"{cc}.alt.txt", f"{cc}.txt")
        rows = []
        with (cache / f"{cc}.txt").open(encoding="utf-8") as fh:
            for line in fh:
                f = line.rstrip("\n").split("\t")
                if len(f) < 15:
                    continue
                code = f[7]
                if not ((f[6] == "P" and code in TOWN_CODES) or code in LANDMARK_CODES):
                    continue
                rows.append(f)
        wanted = {int(f[0]) for f in rows}
        regions = languages.get(cc, {})
        names_by_lang = {
            lang: preferred_names(cache / f"{cc}.alt.txt", lang, wanted) for lang in set(regions.values()) if lang
        }
        for f in rows:
            lang = regions.get(f[10], regions.get("*", ""))
            local, untagged = names_by_lang.get(lang, ({}, {}))
            gid = int(f[0])
            lat, lon = float(f[4]), float(f[5])
            notability = len([a for a in f[3].split(",") if a]) if f[3] else 0
            # [name, feature code, lat, lon, population, notability, order]. The order (position
            # in the GeoNames files) breaks ties between equally important places.
            rec = [display_name(gid, f[1], local, untagged, lang), f[7],
                   lat, lon, int(f[14] or 0), notability, order]
            order += 1
            key = f"{math.floor(lat)}_{math.floor(lon)}"
            tiles.setdefault(key, []).append(rec)
        total += len(rows)
        print(f"{cc}: {len(rows)} places")

    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.json"):
        old.unlink()
    for key, recs in tiles.items():
        recs.sort(key=lambda r: (r[2], r[3]))
        (OUT / f"{key}.json").write_text(json.dumps(recs, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    index = {
        "source": "GeoNames (https://www.geonames.org/), CC BY 4.0",
        "countries": countries,
        "languages": {cc: languages.get(cc) or None for cc in countries},
        "tile_deg": 1,
        "tiles": sorted(tiles),
        "count": total,
    }
    (OUT / "index.json").write_text(json.dumps(index, indent=1), encoding="utf-8")
    size = sum(p.stat().st_size for p in OUT.glob("*.json"))
    print(f"{total} places in {len(tiles)} tiles, {size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
