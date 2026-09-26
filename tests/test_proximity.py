from types import SimpleNamespace

import pytest

from app.similarity import proximity_pairs, simplify_latlon
from tests.helpers import line_points, offset


def route(id, points):
    return SimpleNamespace(id=id, geometry=[[la, lo] for la, lo, _ in points])


START = (51.0, 4.4)


def east_line(north_m=0.0, east_m=0.0, length_m=5000):
    start = offset(*START, north_m, east_m)
    return line_points(start=start, length_m=length_m, step_m=100, heading_deg=90)


def test_parallel_routes_within_distance_share_their_length():
    a = route(1, east_line())
    b = route(2, east_line(north_m=50))  # 50 m north, same 5 km
    [pair] = proximity_pairs([a, b], 100)
    assert (pair.a_id, pair.b_id) == (1, 2)
    assert pair.min_distance_m == pytest.approx(50, abs=1)
    assert pair.a_shared_km == pytest.approx(5.0, rel=0.02)
    assert pair.a_shared_pct == pytest.approx(100, abs=2)
    assert pair.a_segments and pair.b_segments


def test_parallel_routes_outside_distance_are_ignored():
    a = route(1, east_line())
    b = route(2, east_line(north_m=50))
    assert proximity_pairs([a, b], 30) == []


def test_partial_overlap():
    a = route(1, east_line(length_m=4000))
    b = route(2, east_line(east_m=3000, length_m=4000))  # overlaps the last 1 km of a
    [pair] = proximity_pairs([a, b], 20)
    assert pair.min_distance_m == 0
    assert pair.a_shared_km == pytest.approx(1.0, abs=0.05)
    assert pair.a_shared_pct == pytest.approx(25, abs=2)
    assert pair.b_shared_pct == pytest.approx(25, abs=2)


def test_crossing_routes_share_only_a_short_stretch():
    a = route(1, east_line())
    b = route(2, line_points(start=offset(*START, -2500, 2500), length_m=5000, step_m=100, heading_deg=0))
    [pair] = proximity_pairs([a, b], 50)
    assert pair.min_distance_m == 0
    # Only the ~100 m around the crossing (2 x 50 m) is "shared".
    assert pair.a_shared_km == pytest.approx(0.1, abs=0.02)


def test_near_miss_reports_closest_points():
    a = route(1, east_line(length_m=2000))
    # Starts 80 m beyond the end of a, heading further east.
    b = route(2, east_line(east_m=2080, length_m=2000))
    [pair] = proximity_pairs([a, b], 100)
    assert pair.min_distance_m == pytest.approx(80, abs=1)
    end_a, start_b = pair.closest
    assert end_a == pytest.approx(list(a.geometry[-1]), abs=1e-5)
    assert start_b == pytest.approx(list(b.geometry[0]), abs=1e-5)


def test_bbox_prefilter_and_pairs_listed_once():
    routes = [
        route(1, east_line()),
        route(2, east_line(north_m=30)),
        route(3, east_line(north_m=60)),
        route(4, east_line(north_m=50_000)),  # 50 km away
    ]
    pairs = proximity_pairs(routes, 40)
    assert sorted((p.a_id, p.b_id) for p in pairs) == [(1, 2), (2, 3)]


def test_degenerate_input():
    assert proximity_pairs([], 100) == []
    assert proximity_pairs([route(1, east_line())], 100) == []
    assert proximity_pairs([route(1, east_line()), SimpleNamespace(id=2, geometry=[])], 100) == []


def test_simplify_latlon_reduces_points_and_keeps_ends():
    geom = [[la, lo] for la, lo, _ in line_points(length_m=5000, step_m=10)]
    simple = simplify_latlon(geom, 10)
    assert len(simple) < 10
    assert simple[0] == pytest.approx(geom[0], abs=1e-5)
    assert simple[-1] == pytest.approx(geom[-1], abs=1e-5)
    assert simplify_latlon(geom, 0) is geom
