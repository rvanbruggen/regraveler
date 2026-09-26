import numpy as np
import pytest

from app import combiner as cb
from app.gpxstats import compute_stats
from tests.helpers import line_points, loop_points, offset

START = (51.0, 4.4)


def east(north_m=0.0, east_m=0.0, length_m=4000, step_m=20, ele=None):
    return line_points(start=offset(*START, north_m, east_m), length_m=length_m, step_m=step_m,
                       heading_deg=90, ele=ele)


def length_m(points):
    return compute_stats(points).distance_km * 1000


def xy(track, at):
    return cb.point_at(track, at)[:2]


def dist(p, q):
    return float(np.hypot(p[0] - q[0], p[1] - q[1]))


calls = []


def fake_router(p, q):
    """Records calls; returns a straight line with one midpoint."""
    calls.append((p, q))
    mid = ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, None)
    return [(p[0], p[1], None), mid, (q[0], q[1], None)]


@pytest.fixture(autouse=True)
def _reset_calls():
    calls.clear()


# ------------------------------------------------------------------ tracks and sections

def test_make_track_length_and_duplicates():
    pts = east(length_m=1000)
    t = cb.make_track(pts + [pts[-1]])  # trailing duplicate point
    assert t.length == pytest.approx(1000, rel=0.005)
    assert len(t.xyz) == len(pts)


def test_point_at_interpolates_position_and_elevation():
    t = cb.make_track(east(length_m=1000, step_m=100, ele=lambda d: d / 10))  # 0 -> 100 m
    p = cb.point_at(t, 250)
    assert dist(p, t.xyz[0]) == pytest.approx(250, abs=0.5)
    assert p[2] == pytest.approx(25, abs=0.2)
    assert cb.point_at(t, -5)[:2] == pytest.approx(t.xyz[0][:2])
    assert cb.point_at(t, 1e9)[:2] == pytest.approx(t.xyz[-1][:2])


def test_section_forward_and_backward():
    t = cb.make_track(east(length_m=1000, step_m=100))
    fwd = cb.section(t, 150, 650)
    assert cb._leg_length(fwd) == pytest.approx(500, abs=0.5)
    assert dist(fwd[0], cb.point_at(t, 150)) < 0.01
    assert dist(fwd[-1], cb.point_at(t, 650)) < 0.01
    back = cb.section(t, 650, 150)
    assert np.allclose(back, fwd[::-1], equal_nan=True)


def test_section_other_way_round_a_loop():
    t = cb.make_track(loop_points(radius_m=1000, n=360), is_loop=True)
    L = t.length
    direct = cb.section(t, 0.2 * L, 0.6 * L)
    other = cb.section(t, 0.2 * L, 0.6 * L, other_way=True)
    assert cb._leg_length(direct) == pytest.approx(0.4 * L, rel=0.01)
    assert cb._leg_length(other) == pytest.approx(0.6 * L, rel=0.01)
    # Other way: starts at 20 %, ends at 60 %, passing the start point.
    assert dist(other[0], cb.point_at(t, 0.2 * L)) < 0.01
    assert dist(other[-1], cb.point_at(t, 0.6 * L)) < 0.01
    assert min(dist(p, t.xyz[0]) for p in other) < 0.01
    # Same the other way (from > to): forwards through the end/start.
    other2 = cb.section(t, 0.6 * L, 0.2 * L, other_way=True)
    assert cb._leg_length(other2) == pytest.approx(0.6 * L, rel=0.01)
    assert dist(other2[0], cb.point_at(t, 0.6 * L)) < 0.01


def test_locate_projects_onto_route():
    t = cb.make_track(east(length_m=2000))
    lat, lon = offset(*START, 40, 700)  # 40 m north of the 700 m point
    # Positions are in projected metres (within ~1 % of ground distance).
    assert cb.locate(t, lat, lon) / t.length == pytest.approx(700 / 2000, abs=0.001)


# ------------------------------------------------------------------ point to point

def test_single_connection_stitches_a_connector_b():
    a = cb.make_track(east(length_m=4000))
    b = cb.make_track(east(north_m=500, length_m=4000))  # parallel, 500 m north
    res = cb.combine(a, b, [cb.Connection(3000, 1000)], fake_router)
    assert len(calls) == 1
    legs = {leg.kind: leg for leg in res.legs}
    assert cb._leg_length(legs["a"].xyz) == pytest.approx(3000, abs=1)
    assert cb._leg_length(legs["b"].xyz) == pytest.approx(b.length - 1000, abs=1)
    # Connector from (3000 on A) to (1000 on B): 2000 m west, 500 m north.
    assert cb._leg_length(legs["connector"].xyz) == pytest.approx((2000**2 + 500**2) ** 0.5, rel=0.01)
    total = length_m(res.points)
    assert total == pytest.approx(6000 + (2000**2 + 500**2) ** 0.5, rel=0.01)
    # Starts at A's start, ends at B's end.
    assert res.points[0][:2] == pytest.approx(a_start := cb._latlon_of(a.xyz[0]), abs=1e-6)
    assert res.points[-1][:2] == pytest.approx(cb._latlon_of(b.xyz[-1]), abs=1e-6)
    del a_start


def test_single_connection_reversed_parts():
    a = cb.make_track(east(length_m=4000))
    b = cb.make_track(east(north_m=500, length_m=4000))
    res = cb.combine(a, b, [cb.Connection(3000, 1000)], fake_router, reverse_a=True, reverse_b=True)
    legs = {leg.kind: leg for leg in res.legs}
    # A ridden from its end back to 3000 m, B from 1000 m back to its start.
    assert cb._leg_length(legs["a"].xyz) == pytest.approx(a.length - 3000, abs=1)
    assert cb._leg_length(legs["b"].xyz) == pytest.approx(1000, abs=1)
    assert res.points[0][:2] == pytest.approx(cb._latlon_of(a.xyz[-1]), abs=1e-6)
    assert res.points[-1][:2] == pytest.approx(cb._latlon_of(b.xyz[0]), abs=1e-6)


def test_reverse_whole_result():
    a = cb.make_track(east(length_m=4000))
    b = cb.make_track(east(north_m=500, length_m=4000))
    fwd = cb.combine(a, b, [cb.Connection(3000, 1000)], fake_router)
    rev = cb.combine(a, b, [cb.Connection(3000, 1000)], fake_router, reverse=True)
    assert rev.points == fwd.points[::-1]


def test_touching_routes_are_joined_without_routing():
    a = cb.make_track(east(length_m=2000))
    b = cb.make_track(east(north_m=10, east_m=2000, length_m=2000))  # starts 10 m from A's end
    res = cb.combine(a, b, [cb.Connection(2000, 0)], fake_router, direct_join_m=25)
    assert calls == []
    assert res.connectors[0].routed is False
    assert length_m(res.points) == pytest.approx(4010, rel=0.005)


def test_elevation_is_kept_along_the_stitched_route():
    a = cb.make_track(east(length_m=2000, ele=lambda d: 10 + d / 100))  # 10 -> 30 m
    b = cb.make_track(east(north_m=300, length_m=2000, ele=lambda d: 50.0))
    res = cb.combine(a, b, [cb.Connection(2000, 0)], fake_router)
    assert res.points[0][2] == pytest.approx(10, abs=0.1)
    assert res.points[-1][2] == pytest.approx(50, abs=0.1)


# ------------------------------------------------------------------ loops

def two_parallel_lines():
    a = cb.make_track(east(length_m=6000))
    b = cb.make_track(east(north_m=800, length_m=6000))
    return a, b


def test_two_connections_build_a_closed_loop():
    a, b = two_parallel_lines()
    res = cb.combine(a, b, [cb.Connection(5000, 5000), cb.Connection(1000, 1000)], fake_router)
    assert len(calls) == 2
    kinds = [leg.kind for leg in res.legs]
    assert kinds == ["a", "connector", "b", "connector"]
    assert res.points[0][:2] == pytest.approx(res.points[-1][:2], abs=1e-7)
    # A 1000->5000, connector 800 m, B 5000->1000, connector 800 m.
    assert length_m(res.points) == pytest.approx(4000 + 800 + 4000 + 800, rel=0.01)
    assert compute_stats(res.points).is_loop


def test_loop_other_way_round_a_loop_route():
    a = cb.make_track(loop_points(radius_m=1500, n=400), is_loop=True)
    b = cb.make_track(loop_points(center=offset(*START, 0, 4000), radius_m=1500, n=400), is_loop=True)
    L = a.length
    # Two connections on the east side of A (towards B), west side of B.
    cons = [cb.Connection(0.20 * L, 0.80 * L), cb.Connection(0.30 * L, 0.70 * L)]
    short = cb.combine(a, b, cons, fake_router)
    long_a = cb.combine(a, b, cons, fake_router, reverse_a=True)
    a_short = cb._leg_length(short.legs[0].xyz)
    a_long = cb._leg_length(long_a.legs[0].xyz)
    assert a_short == pytest.approx(0.1 * L, rel=0.02)
    assert a_long == pytest.approx(0.9 * L, rel=0.02)


def test_loop_starts_at_route_a_start_when_on_the_loop():
    a = cb.make_track(loop_points(radius_m=1500, n=400), is_loop=True)
    b = cb.make_track(loop_points(center=offset(*START, 0, 4000), radius_m=1500, n=400), is_loop=True)
    L = a.length
    cons = [cb.Connection(0.20 * L, 0.80 * L), cb.Connection(0.30 * L, 0.70 * L)]
    res = cb.combine(a, b, cons, fake_router, reverse_a=True)  # A's long way includes its start
    a_start = cb._latlon_of(a.xyz[0])
    assert res.points[0][:2] == pytest.approx(a_start, abs=1e-6)
    assert res.points[-1][:2] == pytest.approx(a_start, abs=1e-6)
    # Rotation doesn't change the route length.
    no_rotate = cb.combine(a, b, cons, fake_router, reverse_a=True, start_at_a_start=False)
    assert length_m(res.points) == pytest.approx(length_m(no_rotate.points), rel=0.001)


def test_loop_needs_distinct_connection_points():
    a, b = two_parallel_lines()
    with pytest.raises(cb.CombineError):
        cb.combine(a, b, [cb.Connection(1000, 1000), cb.Connection(1000, 3000)], fake_router)
    with pytest.raises(cb.CombineError):
        cb.combine(a, b, [], fake_router)


# ------------------------------------------------------------------ suggestions

def test_suggest_single_connection_finds_closest_points():
    a = cb.make_track(east(length_m=5000))
    # B runs north-south and passes 300 m north of A's 2000 m point.
    b_pts = line_points(start=offset(*START, 300, 2000), length_m=3000, step_m=20, heading_deg=0)
    b = cb.make_track(b_pts)
    [c] = cb.suggest_connections(a, b, 1)
    assert c.a_at == pytest.approx(2000, abs=50)
    assert c.b_at == pytest.approx(0, abs=50)
    assert dist(xy(a, c.a_at), xy(b, c.b_at)) == pytest.approx(300, abs=10)


def test_suggest_two_connections_are_far_apart():
    a, b = two_parallel_lines()
    c1, c2 = cb.suggest_connections(a, b, 2)
    assert abs(c1.a_at - c2.a_at) > 1500
    assert abs(c1.b_at - c2.b_at) > 1500
    for c in (c1, c2):
        assert dist(xy(a, c.a_at), xy(b, c.b_at)) == pytest.approx(800, abs=10)


def test_suggest_second_connection_on_short_routes():
    # Short routes: the minimum separation shrinks to a quarter of the route length.
    a = cb.make_track(east(length_m=600))
    b = cb.make_track(east(north_m=100, length_m=600))
    c1, c2 = cb.suggest_connections(a, b, 2, step_m=10)
    assert abs(c1.a_at - c2.a_at) > 0.25 * a.length


def test_straight_router():
    assert cb.straight_router((51.0, 4.4), (51.1, 4.5)) == [(51.0, 4.4, None), (51.1, 4.5, None)]
