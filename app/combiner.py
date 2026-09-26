"""Combine two routes with routed connectors (phase 3).

All cutting happens on the full-resolution GPX points, in a metric projection. Positions
along a route are distances in metres from its start ("at"), measured in that projection.

Point-to-point (one connection):
    A from its start up to a1  ->  connector a1-b1  ->  B from b1 to its end
    reverse_a: arrive at a1 from A's end instead (A ridden backwards)
    reverse_b: leave b1 towards B's start instead (B ridden backwards)

Loop (two connections):
    A from a2 to a1  ->  connector a1-b1  ->  B from b1 to b2  ->  connector b2-a2
    reverse_a / reverse_b: take the other way round a loop route (through its start/end)

Parts (combine_parts): the general form both of the above are built on. A list of parts, each
ridden from its start point to its end point along its route, joined by connectors:
    A1 -> A2  ->  connector  ->  B1 -> B2  [-> connector -> C1 -> C2 ...]  [-> connector back to A1]
Riding direction follows the order of the two points; other_way takes the other way round a
loop route.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

import numpy as np
import shapely
from shapely.geometry import LineString

from .gpxstats import _FROM_METRIC, _TO_METRIC

LatLon = tuple[float, float]
Point3 = tuple[float, float, float | None]  # lat, lon, ele
# (from (lat, lon), to (lat, lon)) -> [(lat, lon, ele), ...]
Router = Callable[[LatLon, LatLon], list[Point3]]


class CombineError(ValueError):
    pass


# ------------------------------------------------------------------ tracks


@dataclass
class Track:
    """A route as metric points with cumulative distance."""

    xyz: np.ndarray  # (n, 3): x, y (metres), elevation (NaN if unknown)
    cum: np.ndarray  # (n,) distance from the start in metres
    is_loop: bool = False
    line: LineString = field(init=False, repr=False)

    def __post_init__(self):
        self.line = LineString(self.xyz[:, :2])

    @property
    def length(self) -> float:
        return float(self.cum[-1])


def make_track(points: list[Point3], is_loop: bool = False) -> Track:
    if len(points) < 2:
        raise CombineError("A route needs at least two points")
    lat = np.array([p[0] for p in points], dtype=float)
    lon = np.array([p[1] for p in points], dtype=float)
    ele = np.array([np.nan if p[2] is None else p[2] for p in points], dtype=float)
    x, y = _TO_METRIC.transform(lon, lat)
    xyz = np.column_stack([x, y, ele])
    # Drop repeated points so every segment has a length.
    step = np.hypot(np.diff(xyz[:, 0]), np.diff(xyz[:, 1]))
    keep = np.concatenate([[True], step > 0.01])
    xyz = xyz[keep]
    if len(xyz) < 2:
        raise CombineError("A route needs at least two distinct points")
    cum = np.concatenate([[0.0], np.cumsum(np.hypot(np.diff(xyz[:, 0]), np.diff(xyz[:, 1])))])
    return Track(xyz=xyz, cum=cum, is_loop=is_loop)


def point_at(track: Track, at: float) -> np.ndarray:
    """Interpolated (x, y, ele) at distance `at` along the track."""
    at = min(max(at, 0.0), track.length)
    i = int(np.clip(np.searchsorted(track.cum, at, side="right") - 1, 0, len(track.cum) - 2))
    seg = track.cum[i + 1] - track.cum[i]
    f = 0.0 if seg == 0 else (at - track.cum[i]) / seg
    p, q = track.xyz[i], track.xyz[i + 1]
    ele = p[2] + f * (q[2] - p[2]) if not (np.isnan(p[2]) or np.isnan(q[2])) else (p[2] if f < 0.5 else q[2])
    return np.array([p[0] + f * (q[0] - p[0]), p[1] + f * (q[1] - p[1]), ele])


def _forward(track: Track, d0: float, d1: float) -> np.ndarray:
    """Points from d0 to d1 (d0 <= d1), with interpolated end points."""
    d0 = min(max(d0, 0.0), track.length)
    d1 = min(max(d1, 0.0), track.length)
    i0 = np.searchsorted(track.cum, d0, side="right")
    i1 = np.searchsorted(track.cum, d1, side="left")
    inner = track.xyz[i0:i1]
    return np.vstack([point_at(track, d0), inner, point_at(track, d1)])


def section(track: Track, d_from: float, d_to: float, other_way: bool = False) -> np.ndarray:
    """The part of the track travelled from d_from to d_to.

    Direct: along the track between the two positions (backwards if d_from > d_to).
    other_way: the complementary part, passing through the start/end point; only
    meaningful for loop routes.
    """
    if not other_way:
        if d_from <= d_to:
            return _forward(track, d_from, d_to)
        return _forward(track, d_to, d_from)[::-1]
    L = track.length
    if d_from <= d_to:
        # Backwards from d_from to the start, continue from the end backwards to d_to.
        return _join([_forward(track, 0, d_from)[::-1], _forward(track, d_to, L)[::-1]])
    # Forwards from d_from to the end, continue from the start to d_to.
    return _join([_forward(track, d_from, L), _forward(track, 0, d_to)])


def _join(parts: list[np.ndarray], min_gap_m: float = 0.5) -> np.ndarray:
    """Concatenate point arrays, dropping consecutive (near-)duplicate points."""
    pts = np.vstack([p for p in parts if len(p)])
    if len(pts) < 2:
        return pts
    step = np.hypot(np.diff(pts[:, 0]), np.diff(pts[:, 1]))
    keep = np.concatenate([[True], step >= min_gap_m])
    keep[-1] = True
    return pts[keep]


def locate(track: Track, lat: float, lon: float) -> float:
    """Distance along the track of the point nearest to (lat, lon)."""
    x, y = _TO_METRIC.transform(lon, lat)
    return float(track.line.project(shapely.Point(x, y)))


def to_latlon(xyz: np.ndarray) -> list[Point3]:
    lon, lat = _FROM_METRIC.transform(xyz[:, 0], xyz[:, 1])
    return [
        (float(a), float(o), None if np.isnan(e) else float(e))
        for a, o, e in zip(np.atleast_1d(lat), np.atleast_1d(lon), xyz[:, 2])
    ]


def _latlon_of(xyz_point: np.ndarray) -> LatLon:
    lon, lat = _FROM_METRIC.transform(xyz_point[0], xyz_point[1])
    return (float(lat), float(lon))


def _from_latlon(points: list[Point3]) -> np.ndarray:
    lat = np.array([p[0] for p in points], dtype=float)
    lon = np.array([p[1] for p in points], dtype=float)
    ele = np.array([np.nan if p[2] is None else p[2] for p in points], dtype=float)
    x, y = _TO_METRIC.transform(lon, lat)
    return np.column_stack([x, y, ele])


# ------------------------------------------------------------------ suggestions


@dataclass
class Connection:
    a_at: float  # metres along A
    b_at: float  # metres along B


def _along(d: np.ndarray, ref: float, length: float, loop: bool) -> np.ndarray:
    diff = np.abs(d - ref)
    return np.minimum(diff, length - diff) if loop else diff


def _samples(track: Track, step_m: float) -> tuple[np.ndarray, np.ndarray]:
    ds = np.append(np.arange(0.0, track.length, step_m), track.length)
    xy = np.column_stack([np.interp(ds, track.cum, track.xyz[:, 0]), np.interp(ds, track.cum, track.xyz[:, 1])])
    return ds, xy


def suggest_connections(a: Track, b: Track, count: int = 1, step_m: float = 50.0) -> list[Connection]:
    """Where the routes come closest. For count=2, the second pair is the closest pair
    that is well away (along both routes) from the first, so a loop can be formed."""
    # Coarser sampling for very long routes keeps the distance matrix small.
    step = max(step_m, (a.length * b.length / 4e6) ** 0.5)
    da, pa = _samples(a, step)
    db, pb = _samples(b, step)
    dist = np.hypot(pa[:, None, 0] - pb[None, :, 0], pa[:, None, 1] - pb[None, :, 1])

    i, j = np.unravel_index(int(np.argmin(dist)), dist.shape)
    result = [Connection(float(da[i]), float(db[j]))]
    if count >= 2:
        exclude = min(max(2000.0, 0.15 * min(a.length, b.length)), 0.25 * min(a.length, b.length))
        away_a = _along(da, da[i], a.length, a.is_loop) > exclude
        away_b = _along(db, db[j], b.length, b.is_loop) > exclude
        masked = np.where(away_a[:, None] & away_b[None, :], dist, np.inf)
        k, m = np.unravel_index(int(np.argmin(masked)), masked.shape)
        if not np.isfinite(masked[k, m]):
            raise CombineError("The routes are too short to suggest a second connection")
        result.append(Connection(float(da[k]), float(db[m])))
    return result


# ------------------------------------------------------------------ stitching


@dataclass
class Part:
    """The stretch of a route ridden from start_at to end_at (metres along the route)."""

    track: Track
    start_at: float
    end_at: float
    other_way: bool = False  # the other way round a loop route (through its start/end)


def part_key(i: int) -> str:
    """Leg kind of the i-th part: "a", "b", "c", ..."""
    return chr(ord("a") + i)


def suggest_parts(a: Track, b: Track, closed: bool = True, step_m: float = 50.0) -> list[Part]:
    """Four starting points (A1, A2, B1, B2) for combining A and B.

    closed: A1 -> A2 -> B1 -> B2 -> back to A1, using the two closest, well separated pairs.
    open:   A from its start to where it comes closest to B, then B from there to its end.
    """
    if closed:
        c1, c2 = suggest_connections(a, b, 2, step_m)
        return [Part(a, c2.a_at, c1.a_at), Part(b, c1.b_at, c2.b_at)]
    [c] = suggest_connections(a, b, 1, step_m)
    return [Part(a, 0.0, c.a_at), Part(b, c.b_at, b.length)]


@dataclass
class Leg:
    kind: str  # "a", "b", ... (part of that route) or "connector"
    xyz: np.ndarray
    routed: bool = True  # connectors: False when joined directly


@dataclass
class Combined:
    points: list[Point3]  # final route, in riding order
    legs: list[Leg]
    connections: list[Connection] = field(default_factory=list)  # snapped positions (combine)
    connection_points: list[tuple[LatLon, LatLon]] = field(default_factory=list)  # (on A, on B)
    parts: list[Part] = field(default_factory=list)  # clamped parts (combine_parts)
    part_points: list[tuple[LatLon, LatLon]] = field(default_factory=list)  # (start, end) per part

    @property
    def connectors(self) -> list[Leg]:
        return [leg for leg in self.legs if leg.kind == "connector"]


def _leg_length(xyz: np.ndarray) -> float:
    if len(xyz) < 2:
        return 0.0
    return float(np.hypot(np.diff(xyz[:, 0]), np.diff(xyz[:, 1])).sum())


def _connector(p: np.ndarray, q: np.ndarray, router: Router, direct_join_m: float) -> Leg:
    if np.hypot(q[0] - p[0], q[1] - p[1]) <= direct_join_m:
        return Leg("connector", np.vstack([p, q]), routed=False)
    routed = _from_latlon(router(_latlon_of(p), _latlon_of(q)))
    # BRouter snaps to the nearest way; keep the exact cut points at both ends.
    return Leg("connector", _join([p[None, :], routed, q[None, :]]), routed=True)


def combine(
    a: Track,
    b: Track,
    connections: list[Connection],
    router: Router,
    reverse_a: bool = False,
    reverse_b: bool = False,
    reverse: bool = False,
    start_at_a_start: bool = True,
    direct_join_m: float = 25.0,
) -> Combined:
    if len(connections) not in (1, 2):
        raise CombineError("Use one or two connections")
    cons = [
        Connection(min(max(c.a_at, 0.0), a.length), min(max(c.b_at, 0.0), b.length))
        for c in connections
    ]
    pa = [point_at(a, c.a_at) for c in cons]
    pb = [point_at(b, c.b_at) for c in cons]

    if len(cons) == 1:
        c = cons[0]
        parts = [
            Part(a, a.length if reverse_a else 0.0, c.a_at),
            Part(b, c.b_at, 0.0 if reverse_b else b.length),
        ]
        legs = _stitch(parts, router, closed=False, direct_join_m=direct_join_m)
    else:
        c1, c2 = cons
        if abs(c1.a_at - c2.a_at) < 1 or abs(c1.b_at - c2.b_at) < 1:
            raise CombineError("The two connection points on a route must be different")
        parts = [Part(a, c2.a_at, c1.a_at, reverse_a), Part(b, c1.b_at, c2.b_at, reverse_b)]
        legs = _stitch(parts, router, closed=True, direct_join_m=direct_join_m)

    pts = _join([leg.xyz for leg in legs])

    if len(cons) == 2 and start_at_a_start:
        # A loop can start anywhere: start where route A starts, if that is on the loop.
        start = a.xyz[0]
        d = np.hypot(pts[:, 0] - start[0], pts[:, 1] - start[1])
        k = int(np.argmin(d))
        if d[k] < 1.0 and 0 < k < len(pts) - 1:
            pts = np.vstack([pts[k:], pts[1:k + 1]])

    if reverse:
        pts = pts[::-1]

    return Combined(
        points=to_latlon(pts),
        legs=legs,
        connections=cons,
        connection_points=[(_latlon_of(p), _latlon_of(q)) for p, q in zip(pa, pb)],
    )


def _stitch(parts: list[Part], router: Router, closed: bool, direct_join_m: float) -> list[Leg]:
    """Legs in riding order: part, connector, part, ... (and a connector back if closed)."""
    ends = [(point_at(p.track, p.start_at), point_at(p.track, p.end_at)) for p in parts]
    legs: list[Leg] = []
    for i, p in enumerate(parts):
        if i:
            legs.append(_connector(ends[i - 1][1], ends[i][0], router, direct_join_m))
        legs.append(Leg(part_key(i), section(p.track, p.start_at, p.end_at, other_way=p.other_way)))
    if closed:
        legs.append(_connector(ends[-1][1], ends[0][0], router, direct_join_m))
    return legs


def combine_parts(
    parts: list[Part],
    router: Router,
    closed: bool = True,
    reverse: bool = False,
    direct_join_m: float = 25.0,
) -> Combined:
    """Ride each part from its start to its end point, joined by connectors.

    closed: add a connector from the last part's end back to the first part's start; the
    result then starts (and ends) at the first part's start point.
    """
    if len(parts) < 2:
        raise CombineError("Choose at least two routes")
    parts = [
        Part(p.track, min(max(p.start_at, 0.0), p.track.length), min(max(p.end_at, 0.0), p.track.length), p.other_way)
        for p in parts
    ]
    for i, p in enumerate(parts):
        if abs(p.end_at - p.start_at) < 1:
            raise CombineError(f"The two points on route {part_key(i).upper()} must be different")
    legs = _stitch(parts, router, closed, direct_join_m)
    pts = _join([leg.xyz for leg in legs])
    if reverse:
        pts = pts[::-1]
    return Combined(
        points=to_latlon(pts),
        legs=legs,
        parts=parts,
        part_points=[
            (_latlon_of(point_at(p.track, p.start_at)), _latlon_of(point_at(p.track, p.end_at))) for p in parts
        ],
    )


def connectors_cross(parts: list[Part], closed: bool = True) -> bool:
    """Whether the straight lines of the connectors cross each other: usually a sign that one
    route should be ridden the other way (swap its two points)."""
    ends = [(point_at(p.track, p.start_at)[:2], point_at(p.track, p.end_at)[:2]) for p in parts]
    gaps = [(ends[i][1], ends[i + 1][0]) for i in range(len(ends) - 1)]
    if closed:
        gaps.append((ends[-1][1], ends[0][0]))
    lines = [LineString([p, q]) for p, q in gaps if np.hypot(*(q - p)) > 0]
    return any(lines[i].crosses(lines[j]) for i in range(len(lines)) for j in range(i + 1, len(lines)))


def straight_router(p: LatLon, q: LatLon) -> list[Point3]:
    """Fallback 'router': a straight line (no elevation)."""
    return [(p[0], p[1], None), (q[0], q[1], None)]


# ------------------------------------------------------------------ new start point


def restart_loop(track: Track, at: float, reverse: bool = False) -> np.ndarray:
    """A loop route ridden once round from `at` (metres along it) back to `at`.

    The original start and end (at most a couple of hundred metres apart for a loop) are
    joined directly. reverse: ride it the other way round.
    """
    if not track.is_loop:
        raise CombineError("Only a loop route can start somewhere else")
    at = min(max(at, 0.0), track.length)
    pts = _join([_forward(track, at, track.length), _forward(track, 0.0, at)])
    return pts[::-1] if reverse else pts
