import math
import random

import numpy as np
import pytest

from app import gpxstats as g
from tests.helpers import gpx_xml, line_points, loop_points, offset


# ------------------------------------------------------------------ parsing

def test_parse_joins_segments_and_splits_tracks():
    a = line_points(length_m=1000)
    b = line_points(start=(51.1, 4.4), length_m=1000)
    data = gpx_xml([("First", [a[:50], a[50:]]), ("Second", b)], link="https://example.org/r")
    parsed = g.parse_gpx(data)
    assert [t.name for t in parsed.tracks] == ["First", "Second"]
    assert len(parsed.tracks[0].points) == len(a)
    assert parsed.link == "https://example.org/r"


def test_parse_skips_tracks_with_fewer_than_two_points():
    data = gpx_xml([("Tiny", [(51.0, 4.4, 10.0)]), ("Real", line_points(length_m=100))])
    assert [t.name for t in g.parse_gpx(data).tracks] == ["Real"]


def test_parse_falls_back_to_routes():
    data = gpx_xml([("Planned", line_points(length_m=500))], use_route=True)
    parsed = g.parse_gpx(data)
    assert parsed.tracks[0].name == "Planned"


def test_parse_handles_bom():
    data = b"\xef\xbb\xbf" + gpx_xml([("T", line_points(length_m=100))])
    assert len(g.parse_gpx(data).tracks) == 1


@pytest.mark.parametrize("data", [b"not xml", b"<gpx></gpx>", gpx_xml([("Empty", [])])])
def test_parse_rejects_unusable_files(data):
    with pytest.raises(g.GpxError):
        g.parse_gpx(data)


# ------------------------------------------------------------------ distance

def test_distance_one_degree_latitude():
    st = g.compute_stats([(0.0, 0.0, None), (1.0, 0.0, None)])
    assert st.distance_km == pytest.approx(110.574, abs=0.01)


def test_distance_of_straight_line():
    st = g.compute_stats(line_points(length_m=5000, step_m=10))
    assert st.distance_km == pytest.approx(5.0, rel=0.005)


def test_repeated_points_do_not_break_stats():
    pts = line_points(length_m=1000, ele=lambda d: d / 10)
    pts = [p for p in pts for _ in range(2)]  # every point twice
    st = g.compute_stats(pts)
    assert st.distance_km == pytest.approx(1.0, rel=0.01)
    assert st.elevation_gain_m == pytest.approx(100, abs=2)


def test_needs_two_points():
    with pytest.raises(g.GpxError):
        g.compute_stats([(51.0, 4.4, 1.0)])


# ------------------------------------------------------------------ elevation

def test_climb_and_descent():
    # 0 -> 100 m over 5 km, then back down over 5 km.
    ele = lambda d: d / 50 if d <= 5000 else 100 - (d - 5000) / 50
    st = g.compute_stats(line_points(length_m=10000, ele=ele))
    assert st.elevation_gain_m == pytest.approx(100, abs=3)
    assert st.elevation_loss_m == pytest.approx(100, abs=3)
    assert st.max_elevation_m == pytest.approx(100, abs=3)
    assert st.min_elevation_m == pytest.approx(0, abs=1)


def test_gps_noise_on_flat_route_is_not_counted_as_climbing():
    rng = random.Random(42)
    pts = line_points(length_m=20000, step_m=5, ele=lambda d: 10 + rng.uniform(-1.5, 1.5))
    raw_gain = sum(max(0, b[2] - a[2]) for a, b in zip(pts, pts[1:]))
    st = g.compute_stats(pts)
    assert raw_gain > 1000  # the noise alone would add > 1 km of "climbing"
    assert st.elevation_gain_m < 20


def test_real_hills_survive_noise():
    rng = random.Random(1)
    # Five 30 m hills over 20 km plus noise.
    hill = lambda d: 30 * (1 - math.cos(2 * math.pi * d / 4000)) / 2
    pts = line_points(length_m=20000, step_m=5, ele=lambda d: hill(d) + rng.uniform(-1, 1))
    st = g.compute_stats(pts)
    assert st.elevation_gain_m == pytest.approx(150, rel=0.1)


def test_sparse_points_are_resampled_not_skipped():
    # A 200 m climb recorded with points 500 m apart.
    pts = line_points(length_m=10000, step_m=500, ele=lambda d: d / 50)
    st = g.compute_stats(pts)
    assert st.elevation_gain_m == pytest.approx(200, abs=3)


def test_missing_elevation_everywhere():
    st = g.compute_stats(line_points(length_m=1000))
    assert st.elevation_gain_m is None
    assert st.elevation_loss_m is None
    assert st.min_elevation_m is None


def test_missing_elevation_is_interpolated():
    pts = line_points(length_m=2000, ele=lambda d: d / 20)  # 0 -> 100 m
    pts = [(la, lo, e if i % 3 == 0 else None) for i, (la, lo, e) in enumerate(pts)]
    st = g.compute_stats(pts)
    assert st.elevation_gain_m == pytest.approx(100, abs=3)


def test_gain_loss_hysteresis():
    assert g.gain_loss(np.array([0, 0.5, 0, 0.5, 0]), threshold=1) == (0.0, 0.0)
    assert g.gain_loss(np.array([0, 10, 0]), threshold=1) == (10.0, 10.0)
    # The last partial climb (below threshold) still counts.
    gain, loss = g.gain_loss(np.array([0, 5, 5.5]), threshold=1)
    assert gain == pytest.approx(5.5)
    assert loss == 0


# ------------------------------------------------------------------ loop / bbox / geometry

def test_loop_detection():
    st = g.compute_stats(loop_points())
    assert st.is_loop


@pytest.mark.parametrize("gap_m,expected", [(150, True), (300, False)])
def test_loop_threshold(gap_m, expected):
    pts = line_points(length_m=3000, heading_deg=0)
    back = line_points(start=pts[-1][:2], length_m=3000, heading_deg=180)[1:]
    # Shift the return leg east so the end is `gap_m` from the start.
    back = [(*offset(la, lo, 0, gap_m), e) for la, lo, e in back]
    st = g.compute_stats(pts + back)
    assert st.is_loop is expected


def test_bbox_and_endpoints():
    pts = line_points(start=(51.0, 4.4), length_m=1000, heading_deg=45)
    st = g.compute_stats(pts)
    assert (st.start_lat, st.start_lon) == pytest.approx(pts[0][:2])
    assert (st.end_lat, st.end_lon) == pytest.approx(pts[-1][:2])
    assert st.min_lat == pytest.approx(51.0) and st.min_lon == pytest.approx(4.4)
    assert st.max_lat == pytest.approx(pts[-1][0]) and st.max_lon == pytest.approx(pts[-1][1])


def test_simplified_geometry_keeps_shape_and_endpoints():
    pts = line_points(length_m=5000, step_m=10)
    st = g.compute_stats(pts)
    assert len(st.geometry) < 10  # a straight line needs only its endpoints
    assert st.geometry[0] == pytest.approx(list(pts[0][:2]), abs=1e-5)
    assert st.geometry[-1] == pytest.approx(list(pts[-1][:2]), abs=1e-5)
    circle = g.compute_stats(loop_points(n=400)).geometry
    assert 20 < len(circle) <= 401
