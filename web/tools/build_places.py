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

Regions: every town carries the code of its province (GeoNames admin codes, e.g. BE.VLG.VAN),
and data/places/admin.json has their local names and the region each province lies in
(Belgium: Vlaanderen › Antwerpen; France: région › département; the Netherlands, Luxembourg and
Romania have no level above the province, so the region is the country). The catalog groups
routes by the region and province of their start (see LEVELS).

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
import re
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

# Which GeoNames admin levels are the "region" and the "province" per country (0: the country).
# Germany: Land › Kreis (level 3; the Regierungsbezirk in between exists in 4 Länder only).
LEVELS = {"BE": (1, 2), "NL": (0, 1), "LU": (0, 1), "FR": (1, 2), "DE": (1, 3), "IT": (1, 2), "RO": (0, 1)}
# Shorter names than GeoNames' official ones ("Vlaams Gewest", "Provincie Antwerpen").
ADMIN_NAMES = {"BE.VLG": "Vlaanderen", "BE.WAL": "Wallonie", "BE.BRU": "Brussel", "BE.BRU.BRU": "Brussel",
               "DE.02": "Bayern", "DE.08": "Rheinland-Pfalz", "DE.12": "Mecklenburg-Vorpommern", "DE.13": "Sachsen",
               "DE.14": "Sachsen-Anhalt", "IT.01": "Abruzzo"}
_ADMIN_PREFIX = re.compile(
    r"^(provincie|province (du|de la|de l'|des|de)|provincia (di|della|dell'|del)|région|regione( autonoma)?|"
    r"collectivité territoriale de|département (du|de la|de l'|des|de)|landkreis|kreisfreie stadt|stadtkreis|kreis|"
    r"land|freistaat|freie (und )?hansestadt|judeţul|judetul|județul)\s+", re.IGNORECASE)


_ADMIN_PREFIX_APOS = re.compile(r"^(département|province|provincia) (d'|de l'|dell')", re.IGNORECASE)


def short_admin_name(code: str, name: str) -> str:
    return ADMIN_NAMES.get(code) or _ADMIN_PREFIX_APOS.sub("", _ADMIN_PREFIX.sub("", name)).strip() or name
COUNTRY_NAMES = {"BE": "België / Belgique", "NL": "Nederland", "LU": "Lëtzebuerg", "DE": "Deutschland",
                 "FR": "France", "IT": "Italia", "RO": "România"}


def admin_code(cc: str, f: list[str], level: int) -> str | None:
    """The code of a place's admin area at `level` (0 country, 1-3 admin1-3), or None. A level
    in between may be missing ("00"), the area itself not."""
    parts = [cc, f[10], f[11], f[12]][: level + 1]
    if not parts[-1] or parts[-1] == "00" or any(not p for p in parts):
        return None
    return ".".join(parts)

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
    region_names: dict[str, str] = {}  # region code -> local name
    provinces: dict[str, dict] = {}  # code -> {name, region}
    for cc in countries:
        fetch(cache, f"{BASE_URL}/{cc}.zip", cache / f"{cc}.txt", f"{cc}.txt")
        fetch(cache, f"{BASE_URL}/alternatenames/{cc}.zip", cache / f"{cc}.alt.txt", f"{cc}.txt")
        rows, admins = [], []
        with (cache / f"{cc}.txt").open(encoding="utf-8") as fh:
            for line in fh:
                f = line.rstrip("\n").split("\t")
                if len(f) < 15:
                    continue
                code = f[7]
                if f[6] == "A" and code in ("ADM1", "ADM2", "ADM3"):
                    admins.append(f)
                    continue
                if not ((f[6] == "P" and code in TOWN_CODES) or code in LANDMARK_CODES):
                    continue
                rows.append(f)
        wanted = {int(f[0]) for f in rows} | {int(f[0]) for f in admins}
        regions = languages.get(cc, {})
        names_by_lang = {
            lang: preferred_names(cache / f"{cc}.alt.txt", lang, wanted) for lang in set(regions.values()) if lang
        }
        # Local names of the admin areas that are this country's regions and provinces.
        region_level, province_level = LEVELS.get(cc, (0, 1))
        admin_names: dict[str, str] = {}
        for f in admins:
            level = int(f[7][3])
            key = admin_code(cc, f, level)
            if not key:
                continue
            lang = languages.get(cc, {}).get(f[10], languages.get(cc, {}).get("*", ""))
            local, untagged = names_by_lang.get(lang, ({}, {}))
            admin_names[key] = short_admin_name(key, display_name(int(f[0]), f[1], local, untagged, lang))
        admin_names[cc] = COUNTRY_NAMES.get(cc, cc)

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
            if f[6] == "P":
                # The province (and so the region) of a town, when GeoNames knows both.
                prov, reg = admin_code(cc, f, province_level), admin_code(cc, f, region_level)
                if prov and reg and prov in admin_names and reg in admin_names:
                    rec.append(prov)
                    provinces.setdefault(prov, {"name": admin_names[prov], "region": reg})
                    region_names.setdefault(reg, admin_names[reg])
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
    (OUT / "admin.json").write_text(json.dumps({"levels": {cc: LEVELS.get(cc, (0, 1)) for cc in countries},
                                                  "regions": dict(sorted(region_names.items())),
                                                  "provinces": dict(sorted(provinces.items()))},
                                                 ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(region_names)} regions, {len(provinces)} provinces in admin.json")
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
