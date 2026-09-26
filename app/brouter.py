"""Minimal client for a BRouter HTTP server (https://github.com/abrensch/brouter).

Request format (see brouter-server ServerHandler.java):
    GET /brouter?lonlats=lon,lat|lon,lat&profile=gravel&alternativeidx=0&format=geojson
The GeoJSON response holds one LineString feature with [lon, lat, elevation] coordinates.
Errors come back as HTTP 4xx/5xx with a plain-text message (sometimes empty).
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request

from . import config


class BRouterError(Exception):
    """BRouter answered, but could not compute a route."""


class BRouterUnavailable(Exception):
    """BRouter could not be reached."""


def _explain(message: str) -> str:
    m = re.search(r"datafile (\S+\.rd5) not found", message)
    if m:
        return (
            f"BRouter has no routing data for this area (missing tile {m.group(1)}). "
            "Add the tile to BROUTER_TILES and restart (see README)."
        )
    return message


def _request(
    waypoints: list[tuple[float, float]],
    profile: str,
    params: dict[str, str] | None = None,
    base_url: str | None = None,
    timeout: float | None = None,
) -> dict:
    """One routing request through the given (lat, lon) waypoints; returns the GeoJSON feature."""
    base = (base_url or config.BROUTER_URL).rstrip("/")
    query = {
        "lonlats": "|".join(f"{lon:.6f},{lat:.6f}" for lat, lon in waypoints),
        "profile": profile,
        "alternativeidx": "0",
        "format": "geojson",
    }
    for key, value in (params or {}).items():
        query[f"profile:{key}"] = value
    url = f"{base}/brouter?{urllib.parse.urlencode(query, safe=',|:')}"
    try:
        with urllib.request.urlopen(url, timeout=timeout or config.BROUTER_TIMEOUT_S) as resp:
            body = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace").strip()
        raise BRouterError(_explain(text) or f"BRouter returned HTTP {exc.code} (unknown profile '{profile}'?)")
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        raise BRouterUnavailable(f"BRouter is not reachable at {base}: {reason}")

    try:
        feature = json.loads(body)["features"][0]
        feature["geometry"]["coordinates"]
    except (ValueError, KeyError, IndexError, TypeError):
        raise BRouterError(_explain(body.strip()) or "BRouter returned an unexpected response")
    return feature


def _points(feature: dict) -> list[tuple[float, float, float | None]]:
    points = [
        (float(c[1]), float(c[0]), float(c[2]) if len(c) > 2 and c[2] is not None else None)
        for c in feature["geometry"]["coordinates"]
    ]
    if len(points) < 2:
        raise BRouterError("BRouter returned an empty route")
    return points


def route(
    start: tuple[float, float],
    end: tuple[float, float],
    profile: str,
    params: dict[str, str] | None = None,
    base_url: str | None = None,
    timeout: float | None = None,
) -> list[tuple[float, float, float | None]]:
    """Route between two (lat, lon) points; returns [(lat, lon, ele), ...]."""
    return _points(_request([start, end], profile, params, base_url, timeout))


def way_tags(
    waypoints: list[tuple[float, float]],
    profile: str,
    params: dict[str, str] | None = None,
    base_url: str | None = None,
    timeout: float | None = None,
) -> tuple[float, list[tuple[float, dict[str, str]]], list[tuple[float, float]]]:
    """Route through the waypoints: (length_m, [(distance_m, {tag: value}), ...], [(lat, lon), ...]).

    Uses the per-segment "messages" table of BRouter's GeoJSON output (Distance and WayTags
    columns). Pass params={"processUnusedTags": "1"} to get all OSM tags, not only the ones
    the profile uses.
    """
    feature = _request(waypoints, profile, params, base_url, timeout)
    props = feature.get("properties", {})
    messages = props.get("messages") or []
    rows: list[tuple[float, dict[str, str]]] = []
    if messages:
        header = messages[0]
        try:
            di, wi = header.index("Distance"), header.index("WayTags")
        except ValueError:
            raise BRouterError("BRouter response has no Distance/WayTags columns")
        for m in messages[1:]:
            tags = dict(kv.split("=", 1) for kv in str(m[wi]).split() if "=" in kv)
            rows.append((float(m[di]), tags))
    length = float(props.get("track-length") or sum(d for d, _ in rows))
    coords = [(float(c[1]), float(c[0])) for c in feature["geometry"]["coordinates"]]
    return length, rows, coords
