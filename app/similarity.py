"""Geometric comparison of routes (near-duplicate detection, overlap)."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from shapely import STRtree
from shapely.geometry import LineString
from shapely.ops import nearest_points

from . import config
from .gpxstats import _FROM_METRIC, _TO_METRIC

# ~1 km in degrees latitude; used to grow bounding boxes before comparing.
_DEG_PER_M = 1 / 111_000


def to_metric_line(geometry: list[list[float]]) -> LineString:
    arr = np.asarray(geometry, dtype=float)
    x, y = _TO_METRIC.transform(arr[:, 1], arr[:, 0])
    return LineString(np.column_stack([x, y]))


def bboxes_near(a: tuple, b: tuple, margin_m: float) -> bool:
    """Bounding boxes (min_lat, min_lon, max_lat, max_lon) overlap, grown by margin_m."""
    m = margin_m * _DEG_PER_M
    # Longitude degrees are shorter than latitude degrees, so using the latitude
    # factor for both is a (safe) overestimate of the margin.
    return not (
        a[2] + m < b[0] or b[2] + m < a[0] or a[3] + m * 2 < b[1] or b[3] + m * 2 < a[1]
    )


def overlap_fraction(a: LineString, b: LineString, tolerance_m: float) -> float:
    """Fraction of line a's length that lies within tolerance_m of line b."""
    if a.length == 0:
        return 0.0
    return a.intersection(b.buffer(tolerance_m)).length / a.length


@dataclass
class Similarity:
    other_id: int
    a_in_b: float  # fraction of the new/current route covered by the other route
    b_in_a: float  # fraction of the other route covered by the current route

    @property
    def very_similar(self) -> bool:
        return min(self.a_in_b, self.b_in_a) >= config.SIMILAR_MIN_OVERLAP


def find_similar(
    geometry: list[list[float]],
    bbox: tuple,
    candidates,
    tolerance_m: float | None = None,
    min_overlap: float | None = None,
) -> list[Similarity]:
    """Compare a route against candidate routes (objects with id, bbox, geometry).

    Returns candidates where at least `min_overlap` of either route lies within
    `tolerance_m` of the other, sorted by similarity (most similar first).
    """
    tol = config.SIMILAR_TOLERANCE_M if tolerance_m is None else tolerance_m
    threshold = config.SIMILAR_MIN_OVERLAP if min_overlap is None else min_overlap
    line = None
    results = []
    for c in candidates:
        if not bboxes_near(bbox, c.bbox, tol):
            continue
        if line is None:
            line = to_metric_line(geometry)
        other = to_metric_line(c.geometry)
        a_in_b = overlap_fraction(line, other, tol)
        if a_in_b == 0:
            continue
        b_in_a = overlap_fraction(other, line, tol)
        if max(a_in_b, b_in_a) >= threshold:
            results.append(Similarity(c.id, round(a_in_b, 3), round(b_in_a, 3)))
    results.sort(key=lambda s: min(s.a_in_b, s.b_in_a), reverse=True)
    return results


# ------------------------------------------------------------------ proximity (map view)

# Shared stretches are for display only; simplify them to keep responses small.
SEGMENT_SIMPLIFY_M = 20.0


def to_latlon_lines(geom, digits: int = 6) -> list[list[list[float]]]:
    """Metric (Multi)LineString / GeometryCollection -> list of [[lat, lon], ...] lines."""
    lines = []
    for part in getattr(geom, "geoms", [geom]):
        if part.is_empty:
            continue
        if part.geom_type == "LineString":
            x, y = np.asarray(part.xy)
            lon, lat = _FROM_METRIC.transform(x, y)
            lines.append([[round(float(a), digits), round(float(o), digits)] for a, o in zip(lat, lon)])
        elif part.geom_type in ("MultiLineString", "GeometryCollection"):
            lines.extend(to_latlon_lines(part, digits))
    return lines


def _latlon(point) -> list[float]:
    lon, lat = _FROM_METRIC.transform(point.x, point.y)
    return [round(float(lat), 6), round(float(lon), 6)]


@dataclass
class ProximityPair:
    a_id: int
    b_id: int
    min_distance_m: float
    a_shared_km: float  # length of route a within the distance of route b
    b_shared_km: float
    a_shared_pct: float
    b_shared_pct: float
    closest: list[list[float]]  # [[lat, lon] on a, [lat, lon] on b]
    a_segments: list  # parts of a within the distance of b, as lat/lon lines
    b_segments: list


def proximity_pairs(routes, distance_m: float) -> list[ProximityPair]:
    """All pairs of routes that come within `distance_m` of each other.

    `routes`: objects with `id` and `geometry` ([[lat, lon], ...]).
    Uses an STRtree: bounding boxes (grown by the distance) are the prefilter, then the
    exact line-to-line distance is checked. For each pair the shared stretches are
    computed (each route's parts within `distance_m` of the other).
    """
    routes = [r for r in routes if r.geometry and len(r.geometry) >= 2]
    if len(routes) < 2:
        return []
    lines = [to_metric_line(r.geometry) for r in routes]
    tree = STRtree(lines)
    left, right = tree.query(lines, predicate="dwithin", distance=distance_m)

    buffers: dict[int, object] = {}

    def buffer(i):
        if i not in buffers:
            buffers[i] = lines[i].buffer(distance_m, quad_segs=4)
        return buffers[i]

    pairs = []
    for i, j in zip(left.tolist(), right.tolist()):
        if i >= j:
            continue  # each pair once, and skip self-matches
        a, b = lines[i], lines[j]
        a_part = a.intersection(buffer(j))
        b_part = b.intersection(buffer(i))
        pa, pb = nearest_points(a, b)
        pairs.append(
            ProximityPair(
                a_id=routes[i].id,
                b_id=routes[j].id,
                min_distance_m=round(a.distance(b), 1),
                a_shared_km=round(a_part.length / 1000, 2),
                b_shared_km=round(b_part.length / 1000, 2),
                a_shared_pct=round(100 * a_part.length / a.length, 1) if a.length else 0.0,
                b_shared_pct=round(100 * b_part.length / b.length, 1) if b.length else 0.0,
                closest=[_latlon(pa), _latlon(pb)],
                a_segments=to_latlon_lines(a_part.simplify(SEGMENT_SIMPLIFY_M), 5),
                b_segments=to_latlon_lines(b_part.simplify(SEGMENT_SIMPLIFY_M), 5),
            )
        )
    pairs.sort(key=lambda p: (-max(p.a_shared_km, p.b_shared_km), p.min_distance_m))
    return pairs


def simplify_latlon(geometry: list[list[float]], tolerance_m: float) -> list[list[float]]:
    """Further simplify a stored [[lat, lon], ...] geometry for overview maps."""
    if tolerance_m <= 0 or len(geometry) <= 2:
        return geometry
    simple = to_metric_line(geometry).simplify(tolerance_m, preserve_topology=False)
    return to_latlon_lines(simple)[0] if not simple.is_empty else geometry


# ------------------------------------------------------------------ library-wide duplicates


@dataclass
class DuplicatePair:
    a_id: int
    b_id: int
    a_in_b: float  # share of a within tolerance of b
    b_in_a: float
    reversed: bool  # b runs in the opposite direction of a


def _direction_reversed(a: LineString, b: LineString) -> bool:
    """Does b run the opposite way along a? Projects points spread along a onto b and
    checks whether their positions on b mostly decrease."""
    fractions = np.linspace(0.05, 0.95, 19)
    pos = np.array([b.project(a.interpolate(f, normalized=True)) for f in fractions])
    steps = np.diff(pos)
    # Loops wrap around at their start/end: ignore the big jumps.
    steps = steps[np.abs(steps) < 0.5 * b.length]
    return bool(len(steps) and (steps < 0).sum() > (steps > 0).sum())


def duplicate_pairs(routes, tolerance_m: float | None = None, min_overlap: float = 0.9) -> list[DuplicatePair]:
    """Pairs of routes where at least `min_overlap` of one lies within `tolerance_m` of the
    other (so this includes a short route contained in a longer one)."""
    tol = config.SIMILAR_TOLERANCE_M if tolerance_m is None else tolerance_m
    routes = [r for r in routes if r.geometry and len(r.geometry) >= 2]
    if len(routes) < 2:
        return []
    lines = [to_metric_line(r.geometry) for r in routes]
    left, right = STRtree(lines).query(lines, predicate="dwithin", distance=tol)
    buffers: dict[int, object] = {}

    def buffer(i):
        if i not in buffers:
            buffers[i] = lines[i].buffer(tol, quad_segs=4)
        return buffers[i]

    def covered(i, j):  # share of route i within tolerance of route j
        return lines[i].intersection(buffer(j)).length / lines[i].length if lines[i].length else 0.0

    pairs = []
    for i, j in zip(left.tolist(), right.tolist()):
        if i >= j:
            continue
        a_in_b, b_in_a = covered(i, j), covered(j, i)
        if max(a_in_b, b_in_a) < min_overlap:
            continue
        pairs.append(
            DuplicatePair(
                routes[i].id, routes[j].id, round(a_in_b, 3), round(b_in_a, 3),
                _direction_reversed(lines[i], lines[j]),
            )
        )
    return pairs


def group_pairs(pairs: list[DuplicatePair], min_overlap: float) -> list[set[int]]:
    """Connected groups of routes that are near-duplicates of each other (both ways)."""
    parent: dict[int, int] = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for p in pairs:
        if min(p.a_in_b, p.b_in_a) >= min_overlap:
            parent[find(p.a_id)] = find(p.b_id)
    groups: dict[int, set[int]] = {}
    for x in list(parent):
        groups.setdefault(find(x), set()).add(x)
    return [g for g in groups.values() if len(g) > 1]
