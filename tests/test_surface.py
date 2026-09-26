import pytest

from app import combiner, surface
from tests.helpers import line_points


@pytest.mark.parametrize(
    "tags,expected",
    [
        ({"highway": "residential", "surface": "asphalt"}, ("paved", False)),
        ({"highway": "track", "surface": "gravel"}, ("unpaved", False)),
        ({"highway": "unclassified", "surface": "sett"}, ("cobbles", False)),
        ({"highway": "track", "surface": "compacted;gravel"}, ("unpaved", False)),
        ({"highway": "residential"}, ("paved", True)),
        ({"highway": "cycleway"}, ("paved", True)),
        ({"highway": "track", "tracktype": "grade1"}, ("paved", True)),
        ({"highway": "track", "tracktype": "grade3"}, ("unpaved", True)),
        ({"highway": "track"}, ("unpaved", True)),
        ({"highway": "path"}, ("unpaved", True)),
        ({"highway": "footway"}, ("unknown", True)),
        ({}, ("unknown", True)),
    ],
)
def test_classify(tags, expected):
    assert surface.classify(tags) == expected


def track(length_m=10_000):
    return combiner.make_track(line_points(length_m=length_m, step_m=50))


class FakeMatcher:
    """Each request: first half asphalt, then 20 % sett, 30 % track without surface tag."""

    def __init__(self):
        self.calls = []

    def __call__(self, waypoints):
        self.calls.append(waypoints)
        n = len(waypoints) - 1
        length = n * 1000.0  # pretend 1 km between waypoints
        rows = [
            (0.5 * length, {"highway": "tertiary", "surface": "asphalt"}),
            (0.2 * length, {"highway": "residential", "surface": "sett"}),
            (0.3 * length, {"highway": "track", "tracktype": "grade3"}),
        ]
        coords = [(lat, lon) for lat, lon in waypoints]
        return length, rows, coords


def test_estimate_aggregates_categories_and_chunks_requests():
    m = FakeMatcher()
    t = track(10_000)
    gaps = len(surface.match_waypoints(t, 100)) - 1  # ~100 (projected metres)
    res = surface.estimate(t, matcher=m, spacing_m=100, chunk=20)
    # Chunks of at most 20 waypoints sharing their end points, covering every gap once.
    assert len(m.calls) == -(-gaps // 19)
    assert all(len(c) <= 20 for c in m.calls)
    assert sum(len(c) - 1 for c in m.calls) == gaps
    assert m.calls[0][-1] == m.calls[1][0]
    assert res["paved_km"] == pytest.approx(0.5 * gaps)
    assert res["cobbles_km"] == pytest.approx(0.2 * gaps)
    assert res["unpaved_km"] == pytest.approx(0.3 * gaps)
    assert res["unknown_km"] == 0
    assert res["inferred_km"] == pytest.approx(0.3 * gaps)
    assert res["paved_pct"] == 70  # cobbles count as paved
    assert res["top_surfaces"][0][0] == "asphalt"
    assert {cat for cat, _ in res["segments"]} <= {"paved", "cobbles", "unpaved"}


def test_estimate_without_enough_known_surface():
    def mostly_unknown(waypoints):
        return 1000.0, [(800.0, {"highway": "footway"}), (200.0, {"surface": "asphalt"})], list(waypoints)

    res = surface.estimate(track(1000), matcher=mostly_unknown, spacing_m=500)
    assert res["unknown_km"] == pytest.approx(0.8)
    assert res["paved_pct"] is None


def test_segments_follow_the_stretches_in_order():
    segments = []
    coords = [(51.0, 4.0 + i * 0.001) for i in range(11)]  # 10 equal steps
    surface._add_segments(segments, coords, [(300.0, "paved"), (700.0, "unpaved")])
    assert [cat for cat, _ in segments] == ["paved", "unpaved"]
    assert len(segments[0][1]) == 4  # points 0..3 (30 % of the way)
    assert segments[0][1][-1] == segments[1][1][0]  # runs join up


class R:
    def __init__(self, paved_pct=None, paved_source=None):
        self.paved_pct, self.paved_source, self.surface = paved_pct, paved_source, None


@pytest.mark.parametrize(
    "route,overwrite,expected_pct,expected_source",
    [
        (R(), False, 70, "estimated"),
        (R(40, "estimated"), False, 70, "estimated"),
        (R(40, "manual"), False, 40, "manual"),
        (R(40, None), False, 40, None),  # entered before estimates existed: treat as manual
        (R(40, "manual"), True, 70, "estimated"),
    ],
)
def test_apply_estimate_keeps_manual_values(route, overwrite, expected_pct, expected_source):
    surface.apply_estimate(route, {"paved_pct": 70}, overwrite_manual=overwrite)
    assert route.surface == {"paved_pct": 70}
    assert (route.paved_pct, route.paved_source) == (expected_pct, expected_source)
