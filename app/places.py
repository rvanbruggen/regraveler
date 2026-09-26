"""Descriptive route names from the places a route visits.

Place data: GeoNames country dumps (https://download.geonames.org/export/dump/, CC-BY 4.0),
downloaded once into DATA_DIR/geonames/. Towns and villages come with their population;
landmarks are named forests, heaths, hills, parks, lakes, castles and abbeys. Names are
taken in PLACE_NAME_LANGUAGE (Dutch by default) where GeoNames has one, e.g. Zoniënwoud
instead of Forêt de Soignes.

A generated name looks like "Tervuren – Zoniënwoud – Overijse – Huldenberg": the start town,
then up to three noteworthy places in riding order (for a point-to-point route, the last one
is where it ends).
"""
from __future__ import annotations

import io
import logging
import math
import threading
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import LineString

from . import config
from .gpxstats import _TO_METRIC

log = logging.getLogger(__name__)

BASE_URL = "https://download.geonames.org/export/dump"
SEPARATOR = " – "

TOWN_CODES = {"PPL", "PPLA", "PPLA2", "PPLA3", "PPLA4", "PPLC", "PPLS", "PPLF", "PPLL"}
# Landmarks worth putting in a route name, with how close (m) the route must pass their
# (single) GeoNames point: forests and heaths are large, a castle or abbey is not.
LANDMARK_CODES = {
    "FRST": 1500, "FRSTF": 1500, "HTH": 1200, "PRK": 800, "RESN": 1200, "RESF": 1500,
    "HLL": 400, "HLLS": 600, "MT": 400, "LK": 600, "LKS": 800, "RSV": 600,
    "CSTL": 300, "MSTY": 300, "HSTS": 300,
}
# French and Dutch generic words: a French main name with an untagged Dutch alternate
# (GeoNames lists Zoniënwoud without a language code) is shown with the Dutch one.
_FRENCH_START = ("forêt", "foret", "bois", "château", "chateau", "abbaye", "parc", "lac", "étang", "mont ")
_DUTCH_END = ("woud", "bos", "bossen", "kasteel", "abdij", "park", "meer", "vijver", "berg", "heide")

TOWN_PASS_M = 700  # the route "visits" a town when it passes this close to its centre
START_SEARCH_M = 3000


class PlacesUnavailable(Exception):
    pass


@dataclass
class Places:
    names: list[str]
    kinds: np.ndarray  # 0 = town, 1 = landmark
    codes: list[str]
    x: np.ndarray
    y: np.ndarray
    population: np.ndarray
    notability: np.ndarray  # number of alternate names: how widely known a place is


def _dir() -> Path:
    return config.DATA_DIR / "geonames"


def download(countries: list[str] | None = None, force: bool = False) -> list[str]:
    """Download the GeoNames dumps (places + alternate names) for the countries."""
    folder = _dir()
    folder.mkdir(parents=True, exist_ok=True)
    done = []
    for cc in countries or config.GEONAMES_COUNTRIES:
        for url, target, member in (
            (f"{BASE_URL}/{cc}.zip", folder / f"{cc}.txt", f"{cc}.txt"),
            (f"{BASE_URL}/alternatenames/{cc}.zip", folder / f"{cc}.alt.txt", f"{cc}.txt"),
        ):
            if target.exists() and not force:
                continue
            with urllib.request.urlopen(url, timeout=120) as resp:
                data = resp.read()
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                target.write_bytes(zf.read(member))
        done.append(cc)
    return done


def _preferred_names(path: Path, lang: str) -> tuple[dict[int, str], dict[int, list[str]]]:
    """(geonameid -> name in `lang`, geonameid -> alternates without a language code).

    Preferred names first; short, colloquial and historic names are skipped."""
    best: dict[int, tuple[int, str]] = {}
    untagged: dict[int, list[str]] = {}
    if not path.exists():
        return {}, {}
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            f = line.rstrip("\n").split("\t")
            if len(f) < 4:
                continue
            if f[2] == "":
                untagged.setdefault(int(f[1]), []).append(f[3])
                continue
            if f[2] != lang:
                continue
            short, colloquial, historic = (f[5:8] + ["", "", ""])[:3] if len(f) > 5 else ("", "", "")
            if short == "1" or colloquial == "1" or historic == "1":
                continue
            rank = 0 if (len(f) > 4 and f[4] == "1") else 1
            gid = int(f[1])
            if gid not in best or rank < best[gid][0]:
                best[gid] = (rank, f[3])
    return {gid: name for gid, (_, name) in best.items()}, untagged


def _display_name(gid: int, name: str, local: dict[int, str], untagged: dict[int, list[str]], lang: str) -> str:
    if gid in local:
        return local[gid]
    if lang == "nl" and name.lower().startswith(_FRENCH_START):
        for alt in untagged.get(gid, []):
            if alt.lower().endswith(_DUTCH_END) and not alt.lower().startswith(_FRENCH_START):
                return alt
    return name


_cache: Places | None = None
_lock = threading.Lock()


def load(countries: list[str] | None = None) -> Places:
    """Load (and cache) the places of the configured countries; downloads missing files."""
    global _cache
    with _lock:
        if _cache is not None:
            return _cache
        countries = countries or config.GEONAMES_COUNTRIES
        folder = _dir()
        missing = [cc for cc in countries if not (folder / f"{cc}.txt").exists()]
        if missing:
            try:
                download(missing)
            except Exception as exc:
                raise PlacesUnavailable(f"Could not download GeoNames data ({', '.join(missing)}): {exc}")
        names, kinds, codes, lats, lons, pops, notab = [], [], [], [], [], [], []
        for cc in countries:
            lang = config.PLACE_NAME_LANGUAGE
            local, untagged = _preferred_names(folder / f"{cc}.alt.txt", lang)
            with (folder / f"{cc}.txt").open(encoding="utf-8") as fh:
                for line in fh:
                    f = line.rstrip("\n").split("\t")
                    if len(f) < 15:
                        continue
                    fcode = f[7]
                    if f[6] == "P" and fcode in TOWN_CODES:
                        kind = 0
                    elif fcode in LANDMARK_CODES:
                        kind = 1
                    else:
                        continue
                    gid = int(f[0])
                    names.append(_display_name(gid, f[1], local, untagged, lang))
                    kinds.append(kind)
                    codes.append(fcode)
                    lats.append(float(f[4]))
                    lons.append(float(f[5]))
                    pops.append(int(f[14] or 0))
                    notab.append(len([a for a in f[3].split(",") if a]) if f[3] else 0)
        if not names:
            raise PlacesUnavailable("No GeoNames places loaded")
        x, y = _TO_METRIC.transform(np.array(lons), np.array(lats))
        _cache = Places(names, np.array(kinds), codes, np.asarray(x), np.asarray(y),
                        np.array(pops), np.array(notab))
        return _cache


def _importance(places: Places, i: int) -> float:
    if places.kinds[i] == 0:
        return math.log10(places.population[i] + 1) + 0.15 * min(places.notability[i], 20)
    # Landmarks: gravel riders care about forests and heaths; well-known ones rank high.
    return 2.5 + 0.3 * min(places.notability[i], 20)


def generate_name(
    geometry: list[list[float]], is_loop: bool, places: Places | None = None, max_places: int = 3
) -> dict:
    """Proposed name for a route: {"name", "start", "places": [...]} (name None if nothing found)."""
    places = places or load()
    pts = np.asarray(geometry, dtype=float)
    lx, ly = _TO_METRIC.transform(pts[:, 1], pts[:, 0])
    line = LineString(np.column_stack([lx, ly]))
    L = line.length or 1.0

    # Candidates near the route.
    minx, miny, maxx, maxy = line.bounds
    pad = max(START_SEARCH_M, max(LANDMARK_CODES.values()))
    near = np.where(
        (places.x > minx - pad) & (places.x < maxx + pad) & (places.y > miny - pad) & (places.y < maxy + pad)
    )[0]
    if not len(near):
        return {"name": None, "start": None, "places": []}
    geoms = shapely.points(places.x[near], places.y[near])
    dist = shapely.distance(geoms, line)
    along = shapely.line_locate_point(line, geoms)

    # Start: the nearest real town (one with a known population) to the start point,
    # else the nearest town of any size.
    sx, sy = lx[0], ly[0]
    d_start = np.hypot(places.x[near] - sx, places.y[near] - sy)
    towns = places.kinds[near] == 0
    start_i = None
    for cond in (towns & (places.population[near] > 0) & (d_start <= START_SEARCH_M), towns & (d_start <= START_SEARCH_M), towns):
        idx = np.where(cond)[0]
        if len(idx):
            start_i = near[idx[np.argmin(d_start[idx])]]
            break
    if start_i is None:
        return {"name": None, "start": None, "places": []}
    start_name = places.names[start_i]

    # Places the route visits.
    visits = []
    for k, i in enumerate(near):
        limit = TOWN_PASS_M if places.kinds[i] == 0 else LANDMARK_CODES[places.codes[i]]
        if dist[k] > limit or places.names[i] == start_name:
            continue
        # Skip hamlets and odd points ("Rond Punt"): a town needs a population or some fame.
        if places.kinds[i] == 0 and places.population[i] == 0 and places.notability[i] < 3:
            continue
        pos = along[k] / L
        # Not right at the start (or, for a loop, right before the finish).
        if pos < 0.05 or (is_loop and pos > 0.95):
            continue
        visits.append((pos, _importance(places, i), places.names[i], int(places.kinds[i])))

    # One name per place (a forest can have several points), keep the best.
    best: dict[str, tuple] = {}
    for v in visits:
        if v[2] not in best or v[1] > best[v[2]][1]:
            best[v[2]] = v
    visits = list(best.values())

    end_name = None
    if not is_loop:
        ex, ey = lx[-1], ly[-1]
        d_end = np.hypot(places.x[near] - ex, places.y[near] - ey)
        idx = np.where(towns & (d_end <= START_SEARCH_M))[0]
        if len(idx):
            pop_first = idx[places.population[near][idx] > 0]
            pick = pop_first if len(pop_first) else idx
            end_name = places.names[near[pick[np.argmin(d_end[pick])]]]
            if end_name == start_name:
                end_name = None
        visits = [v for v in visits if v[2] != end_name and v[0] < 0.95]

    n_mid = max_places - (1 if end_name else 0)
    chosen = []
    # Spread the picks: the best place in each stretch of the route, then fill up.
    for k in range(n_mid):
        lo, hi = k / n_mid, (k + 1) / n_mid
        in_part = [v for v in visits if lo <= v[0] < hi and v not in chosen]
        if in_part:
            chosen.append(max(in_part, key=lambda v: v[1]))
    for v in sorted(visits, key=lambda v: -v[1]):
        if len(chosen) >= n_mid:
            break
        if v not in chosen:
            chosen.append(v)
    chosen.sort(key=lambda v: v[0])
    parts = [start_name] + [v[2] for v in chosen] + ([end_name] if end_name else [])
    return {"name": SEPARATOR.join(parts), "start": start_name, "places": parts[1:]}


# ------------------------------------------------------------------ renaming helpers

ORIGINAL_PREFIX = "Original name: "


def notes_with_original(notes: str | None, original: str) -> str:
    """Put the original name at the top of the notes (only the first time a route is renamed)."""
    notes = (notes or "").strip()
    if notes.startswith(ORIGINAL_PREFIX):
        return notes
    return f"{ORIGINAL_PREFIX}{original}" + (f"\n\n{notes}" if notes else "")


def disambiguate(name: str, distance_km: float, taken: set[str]) -> str:
    """Add the distance when another route already has this name."""
    if name.lower() not in taken:
        return name
    candidate = f"{name} ({distance_km:.0f} km)"
    n = 2
    while candidate.lower() in taken:
        candidate = f"{name} ({distance_km:.0f} km, {n})"
        n += 1
    return candidate
