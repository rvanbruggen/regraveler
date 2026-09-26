"""Estimate the surface (paved %) of a route from OpenStreetMap data (phase 4).

The route is "map matched" with BRouter: we route through waypoints taken every
SURFACE_WAYPOINT_SPACING_M metres along the GPX track, with the `shortest` profile, so
BRouter follows the track itself. With processUnusedTags=1 BRouter reports all OSM tags of
every way it used, per segment, which gives the surface along the route.

Categories: paved, cobbles (sett/cobblestone: paved, but worth knowing), unpaved, unknown.
When a way has no `surface` tag, its type decides (a residential street is paved, a
grade 3 track is not); that share is reported as "inferred".
"""
from __future__ import annotations

import logging
import queue
import threading
from collections import Counter
from datetime import datetime, timezone
from typing import Callable

import numpy as np

from . import brouter, combiner, config
from .gpxstats import GEOD
from .similarity import simplify_latlon

log = logging.getLogger(__name__)

PAVED = {
    "paved", "asphalt", "chipseal", "concrete", "concrete:lanes", "concrete:plates",
    "paving_stones", "paving_stones:lanes", "bricks", "brick", "metal", "metal_grid",
    "wood", "rubber", "tartan", "acrylic",
}
COBBLES = {"sett", "cobblestone", "unhewn_cobblestone", "cobblestone:flattened"}
UNPAVED = {
    "unpaved", "compacted", "fine_gravel", "gravel", "shells", "rock", "pebblestone", "ground",
    "dirt", "earth", "grass", "grass_paver", "mud", "sand", "woodchips", "snow", "ice", "salt",
    "soil", "clay",
}
# Roads that are paved unless tagged otherwise.
PAVED_HIGHWAYS = {
    "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
    "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified", "residential",
    "living_street", "service", "pedestrian", "cycleway", "busway", "road",
}
UNPAVED_HIGHWAYS = {"path", "bridleway"}

CATEGORIES = ("paved", "cobbles", "unpaved", "unknown")


def classify(tags: dict[str, str]) -> tuple[str, bool]:
    """(category, inferred) for a way's OSM tags."""
    surface = (tags.get("surface") or "").split(";")[0].strip()
    if surface in PAVED:
        return "paved", False
    if surface in COBBLES:
        return "cobbles", False
    if surface in UNPAVED:
        return "unpaved", False
    highway = tags.get("highway", "")
    if highway == "track":
        grade = tags.get("tracktype", "")
        return ("paved" if grade == "grade1" else "unpaved"), True
    if highway in PAVED_HIGHWAYS:
        return "paved", True
    if highway in UNPAVED_HIGHWAYS:
        return "unpaved", True
    return "unknown", True


# (waypoints [(lat, lon)]) -> (length_m, [(distance_m, tags)], [(lat, lon)] geometry)
Matcher = Callable[
    [list[tuple[float, float]]],
    tuple[float, list[tuple[float, dict[str, str]]], list[tuple[float, float]]],
]


def brouter_matcher(waypoints):
    return brouter.way_tags(waypoints, config.SURFACE_MATCH_PROFILE, {"processUnusedTags": "1"})


def match_waypoints(track: combiner.Track, spacing_m: float) -> list[tuple[float, float]]:
    ds = np.append(np.arange(0.0, track.length, spacing_m), track.length)
    return [combiner._latlon_of(combiner.point_at(track, d)) for d in ds]


def estimate(
    track: combiner.Track,
    matcher: Matcher | None = None,
    spacing_m: float | None = None,
    chunk: int = 60,
) -> dict:
    """Surface breakdown of a route (km per category) and the resulting paved %."""
    spacing = spacing_m or config.SURFACE_WAYPOINT_SPACING_M
    matcher = matcher or brouter_matcher
    waypoints = match_waypoints(track, spacing)
    km = Counter()
    inferred = 0.0
    surfaces = Counter()
    matched = 0.0
    segments: list[list] = []  # [[category, [[lat, lon], ...]], ...] for colouring the map
    # BRouter requests with a limited number of waypoints; consecutive chunks share an end point.
    for i in range(0, len(waypoints) - 1, chunk - 1):
        part = waypoints[i:i + chunk]
        if len(part) < 2:
            break
        length, rows, coords = matcher(part)
        matched += length
        cats = []
        for dist, tags in rows:
            cat, was_inferred = classify(tags)
            cats.append((dist, cat))
            km[cat] += dist
            if was_inferred:
                inferred += dist
            surfaces[tags.get("surface") or f"({tags.get('highway', 'unknown')})"] += dist
        _add_segments(segments, coords, cats)
    # Display only: simplify each run to keep the stored estimate small.
    segments = [[cat, simplify_latlon(line, 4)] for cat, line in segments]

    total = sum(km.values()) or matched
    known = km["paved"] + km["cobbles"] + km["unpaved"]
    paved_pct = round(100 * (km["paved"] + km["cobbles"]) / known) if known and known >= 0.5 * total else None
    return {
        **{f"{c}_km": round(km[c] / 1000, 2) for c in CATEGORIES},
        "inferred_km": round(inferred / 1000, 2),
        "matched_km": round(matched / 1000, 2),
        "route_km": round(track.length / 1000, 2),
        "match_ratio": round(matched / track.length, 3) if track.length else None,
        "paved_pct": paved_pct,
        "top_surfaces": [[name, round(m / 1000, 2)] for name, m in surfaces.most_common(8)],
        "segments": segments,
        "estimated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def _add_segments(segments: list, coords: list[tuple[float, float]], cats: list[tuple[float, str]]) -> None:
    """Split the routed geometry into runs of one surface category.

    BRouter's message rows give the length of each stretch in order; walk along the
    geometry by distance and give every point the category of the stretch it is in."""
    if len(coords) < 2 or not cats:
        return
    lat = np.array([c[0] for c in coords])
    lon = np.array([c[1] for c in coords])
    _, _, step = GEOD.inv(lon[:-1], lat[:-1], lon[1:], lat[1:])
    along = np.concatenate([[0.0], np.cumsum(step)])
    bounds = np.cumsum([d for d, _ in cats])
    # Scale: the message distances and our geometry lengths differ slightly.
    if bounds[-1] > 0:
        bounds = bounds * (along[-1] / bounds[-1])
    idx = np.minimum(np.searchsorted(bounds, along[1:] - 1e-9, side="left"), len(cats) - 1)
    for k in range(1, len(coords)):
        cat = cats[idx[k - 1]][1]
        point = [round(coords[k][0], 5), round(coords[k][1], 5)]
        if segments and segments[-1][0] == cat and segments[-1][1][-1] == [round(coords[k - 1][0], 5), round(coords[k - 1][1], 5)]:
            segments[-1][1].append(point)
        else:
            segments.append([cat, [[round(coords[k - 1][0], 5), round(coords[k - 1][1], 5)], point]])


def apply_estimate(route, result: dict, overwrite_manual: bool = False) -> bool:
    """Store the estimate on the route. The paved % is only replaced if it was not entered
    by hand (or overwrite_manual). Returns True if paved_pct was set from the estimate."""
    route.surface = result
    manual = route.paved_source == "manual" or (route.paved_pct is not None and route.paved_source is None)
    if manual and not overwrite_manual:
        return False
    route.paved_pct = result["paved_pct"]
    route.paved_source = "estimated" if result["paved_pct"] is not None else None
    return True


# ------------------------------------------------------------------ background worker


class SurfaceWorker:
    """Estimates routes one by one in a background thread (BRouter is single-threaded
    by default, so one worker is enough)."""

    def __init__(self):
        self._queue: queue.Queue = queue.Queue()
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._pending: set[int] = set()
        self.done = 0
        self.failed = 0
        self.current: int | None = None
        self.last_error: str | None = None

    def enqueue(self, route_ids, force: bool = False, overwrite_manual: bool = False) -> int:
        added = 0
        with self._lock:
            if not self._pending:
                self.done = self.failed = 0
                self.last_error = None
            for rid in route_ids:
                if rid in self._pending:
                    continue
                self._pending.add(rid)
                self._queue.put((rid, force, overwrite_manual))
                added += 1
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._run, name="surface-worker", daemon=True)
                self._thread.start()
        return added

    def status(self) -> dict:
        with self._lock:
            return {
                "running": bool(self._pending),
                "queued": len(self._pending),
                "done": self.done,
                "failed": self.failed,
                "current": self.current,
                "last_error": self.last_error,
            }

    def wait(self, timeout: float = 30.0) -> bool:
        """Block until the queue is empty (for tests and the CLI)."""
        deadline = datetime.now().timestamp() + timeout
        while datetime.now().timestamp() < deadline:
            if not self.status()["running"]:
                return True
            threading.Event().wait(0.05)
        return False

    def _run(self):
        from . import db
        from .models import Route
        from .main import load_track  # late import: main imports this module

        while True:
            try:
                rid, force, overwrite_manual = self._queue.get(timeout=1.0)
            except queue.Empty:
                with self._lock:
                    if self._queue.empty():
                        self._thread = None
                        return
                continue
            self.current = rid
            try:
                with db.SessionLocal() as session:
                    route = session.get(Route, rid)
                    if route is not None and (force or not route.surface):
                        result = estimate(load_track(route))
                        apply_estimate(route, result, overwrite_manual)
                        session.commit()
                with self._lock:
                    self.done += 1
            except Exception as exc:  # keep going with the other routes
                log.warning("Surface estimate for route %s failed: %s", rid, exc)
                with self._lock:
                    self.failed += 1
                    self.last_error = str(getattr(exc, "detail", exc))
            finally:
                with self._lock:
                    self._pending.discard(rid)
                    self.current = None


worker = SurfaceWorker()
