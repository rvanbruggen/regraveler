"""GPX parsing and route statistics.

Pure functions, no database access, so they are easy to test.
"""
from __future__ import annotations

import io
from dataclasses import dataclass, field

import gpxpy
import gpxpy.gpx
import numpy as np
from pyproj import Geod, Transformer
from shapely.geometry import LineString

from . import config

GEOD = Geod(ellps="WGS84")
# ETRS89 / LAEA Europe: metric projection that works well across Europe.
METRIC_CRS = "EPSG:3035"
_TO_METRIC = Transformer.from_crs("EPSG:4326", METRIC_CRS, always_xy=True)
_FROM_METRIC = Transformer.from_crs(METRIC_CRS, "EPSG:4326", always_xy=True)

# Elevation processing parameters. Calibrated against the "NNkm-NNNhm" values in
# the track names of the gravelroutedatabase.be files (median ratio ~0.95).
RESAMPLE_STEP_M = 10.0  # resample the profile at a fixed distance step
SMOOTH_WINDOW_M = 50.0  # moving-average window over distance
GAIN_THRESHOLD_M = 1.0  # hysteresis: ignore up/down changes smaller than this
# Tolerance for the simplified display geometry.
SIMPLIFY_TOLERANCE_M = 5.0


class GpxError(ValueError):
    """The file is not a usable GPX file."""


@dataclass
class Track:
    name: str | None
    # (lat, lon, ele) tuples; ele may be None.
    points: list[tuple[float, float, float | None]]


@dataclass
class ParsedGpx:
    name: str | None
    description: str | None
    link: str | None
    tracks: list[Track] = field(default_factory=list)


@dataclass
class RouteStats:
    distance_km: float
    elevation_gain_m: float | None
    elevation_loss_m: float | None
    min_elevation_m: float | None
    max_elevation_m: float | None
    start_lat: float
    start_lon: float
    end_lat: float
    end_lon: float
    min_lat: float
    min_lon: float
    max_lat: float
    max_lon: float
    is_loop: bool
    # Simplified geometry as [[lat, lon], ...], ready for Leaflet.
    geometry: list[list[float]]


def parse_gpx(data: bytes | str) -> ParsedGpx:
    """Parse GPX content into tracks.

    Every <trk> with at least two points becomes a Track (its segments are joined).
    Files without tracks fall back to <rte> routes.
    """
    if isinstance(data, bytes):
        data = data.decode("utf-8-sig", errors="replace")
    try:
        gpx = gpxpy.parse(io.StringIO(data))
    except Exception as exc:  # gpxpy raises a variety of exception types
        raise GpxError(f"Could not parse GPX: {exc}") from exc

    tracks: list[Track] = []
    for trk in gpx.tracks:
        pts = [
            (p.latitude, p.longitude, p.elevation)
            for seg in trk.segments
            for p in seg.points
        ]
        if len(pts) >= 2:
            tracks.append(Track(name=_clean(trk.name), points=pts))
    if not tracks:
        for rte in gpx.routes:
            pts = [(p.latitude, p.longitude, p.elevation) for p in rte.points]
            if len(pts) >= 2:
                tracks.append(Track(name=_clean(rte.name), points=pts))
    if not tracks:
        raise GpxError("GPX file contains no track or route with at least two points")

    link = gpx.link or None
    if not link:
        for trk in gpx.tracks:
            if trk.link:
                link = trk.link
                break
    if not link:
        for wpt in gpx.waypoints:
            if wpt.link:
                link = wpt.link
                break
    return ParsedGpx(
        name=_clean(gpx.name),
        description=_clean(gpx.description),
        link=link,
        tracks=tracks,
    )


def _clean(s: str | None) -> str | None:
    if s is None:
        return None
    s = s.strip()
    return s or None


def cumulative_distance_m(lats: np.ndarray, lons: np.ndarray) -> np.ndarray:
    """Cumulative geodesic distance along the points, starting at 0."""
    if len(lats) < 2:
        return np.zeros(len(lats))
    _, _, d = GEOD.inv(lons[:-1], lats[:-1], lons[1:], lats[1:])
    return np.concatenate([[0.0], np.cumsum(d)])


def smoothed_profile(
    dist: np.ndarray, ele: np.ndarray
) -> tuple[np.ndarray, np.ndarray] | None:
    """Resample elevation to a fixed distance step and smooth it.

    `ele` may contain NaN for missing values; they are interpolated.
    Returns (distance, elevation) arrays, or None if there is not enough elevation data.
    """
    known = ~np.isnan(ele)
    if known.sum() < 2:
        return None
    # Collapse duplicate distances (repeated points) so interpolation is well defined.
    d_known, idx = np.unique(dist[known], return_index=True)
    e_known = ele[known][idx]
    if len(d_known) < 2:
        return None
    total = dist[-1]
    grid = np.arange(0.0, total + RESAMPLE_STEP_M, RESAMPLE_STEP_M)
    grid[-1] = min(grid[-1], total)
    resampled = np.interp(grid, d_known, e_known)

    window = max(1, int(round(SMOOTH_WINDOW_M / RESAMPLE_STEP_M)))
    if window > 1 and len(resampled) > window:
        pad = window // 2
        padded = np.pad(resampled, (pad, window - 1 - pad), mode="edge")
        kernel = np.ones(window) / window
        resampled = np.convolve(padded, kernel, mode="valid")
    return grid, resampled


def gain_loss(ele: np.ndarray, threshold: float | None = None) -> tuple[float, float]:
    """Total ascent and descent, ignoring oscillations smaller than `threshold`.

    Hysteresis: a change is only counted once the elevation has moved at least
    `threshold` from the last reference level in one direction.
    """
    if threshold is None:
        threshold = GAIN_THRESHOLD_M
    if len(ele) < 2:
        return 0.0, 0.0
    gain = loss = 0.0
    ref = float(ele[0])
    for v in ele[1:]:
        v = float(v)
        if v - ref >= threshold:
            gain += v - ref
            ref = v
        elif ref - v >= threshold:
            loss += ref - v
            ref = v
    # Count the remainder of the final climb or descent.
    last = float(ele[-1])
    if last > ref:
        gain += last - ref
    else:
        loss += ref - last
    return gain, loss


def simplify_geometry(
    lats: np.ndarray, lons: np.ndarray, tolerance_m: float = SIMPLIFY_TOLERANCE_M
) -> list[list[float]]:
    x, y = _TO_METRIC.transform(lons, lats)
    line = LineString(np.column_stack([x, y]))
    simple = line.simplify(tolerance_m, preserve_topology=False)
    sx, sy = np.asarray(simple.xy)
    slon, slat = _FROM_METRIC.transform(sx, sy)
    return [[round(float(a), 6), round(float(o), 6)] for a, o in zip(slat, slon)]


def compute_stats(points: list[tuple[float, float, float | None]]) -> RouteStats:
    if len(points) < 2:
        raise GpxError("A route needs at least two points")
    lats = np.array([p[0] for p in points], dtype=float)
    lons = np.array([p[1] for p in points], dtype=float)
    ele = np.array([np.nan if p[2] is None else p[2] for p in points], dtype=float)

    dist = cumulative_distance_m(lats, lons)
    profile = smoothed_profile(dist, ele)
    if profile is None:
        gain = loss = min_e = max_e = None
    else:
        _, smooth = profile
        gain, loss = gain_loss(smooth)
        gain, loss = round(gain), round(loss)
        min_e, max_e = round(float(smooth.min()), 1), round(float(smooth.max()), 1)

    _, _, start_end = GEOD.inv(lons[0], lats[0], lons[-1], lats[-1])
    return RouteStats(
        distance_km=round(float(dist[-1]) / 1000.0, 2),
        elevation_gain_m=gain,
        elevation_loss_m=loss,
        min_elevation_m=min_e,
        max_elevation_m=max_e,
        start_lat=float(lats[0]),
        start_lon=float(lons[0]),
        end_lat=float(lats[-1]),
        end_lon=float(lons[-1]),
        min_lat=float(lats.min()),
        min_lon=float(lons.min()),
        max_lat=float(lats.max()),
        max_lon=float(lons.max()),
        is_loop=bool(start_end <= config.LOOP_THRESHOLD_M),
        geometry=simplify_geometry(lats, lons),
    )
