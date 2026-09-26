"""Geometric comparison of routes (near-duplicate detection, overlap)."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from shapely.geometry import LineString

from . import config
from .gpxstats import _TO_METRIC

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
