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


def route(
    start: tuple[float, float],
    end: tuple[float, float],
    profile: str,
    params: dict[str, str] | None = None,
    base_url: str | None = None,
    timeout: float | None = None,
) -> list[tuple[float, float, float | None]]:
    """Route between two (lat, lon) points; returns [(lat, lon, ele), ...]."""
    base = (base_url or config.BROUTER_URL).rstrip("/")
    query = {
        "lonlats": f"{start[1]:.6f},{start[0]:.6f}|{end[1]:.6f},{end[0]:.6f}",
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
        data = json.loads(body)
        coords = data["features"][0]["geometry"]["coordinates"]
    except (ValueError, KeyError, IndexError, TypeError):
        raise BRouterError(_explain(body.strip()) or "BRouter returned an unexpected response")
    points = [
        (float(c[1]), float(c[0]), float(c[2]) if len(c) > 2 and c[2] is not None else None)
        for c in coords
    ]
    if len(points) < 2:
        raise BRouterError("BRouter returned an empty route")
    return points
