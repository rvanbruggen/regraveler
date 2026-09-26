"""Build synthetic GPX files for tests."""
from __future__ import annotations

import math

# Metres per degree latitude (approximately; good enough to build test tracks).
M_PER_DEG_LAT = 111_320.0


def offset(lat: float, lon: float, north_m: float, east_m: float) -> tuple[float, float]:
    dlat = north_m / M_PER_DEG_LAT
    dlon = east_m / (M_PER_DEG_LAT * math.cos(math.radians(lat)))
    return lat + dlat, lon + dlon


def line_points(start=(51.0, 4.4), length_m=5000.0, step_m=10.0, heading_deg=90.0, ele=None):
    """Points along a straight line. `ele` is a function of distance (m) or None."""
    n = int(length_m / step_m)
    h = math.radians(heading_deg)
    pts = []
    for i in range(n + 1):
        d = i * step_m
        lat, lon = offset(start[0], start[1], d * math.cos(h), d * math.sin(h))
        pts.append((lat, lon, None if ele is None else ele(d)))
    return pts


def gpx_xml(tracks, name=None, link=None, use_route=False):
    """tracks: list of (track_name, [segment_points, ...]) or (track_name, points)."""
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<gpx version="1.1" creator="tests" xmlns="http://www.topografix.com/GPX/1/1">']
    if name or link:
        out.append("<metadata>")
        if name:
            out.append(f"<name>{name}</name>")
        if link:
            out.append(f'<link href="{link}"></link>')
        out.append("</metadata>")
    for tname, segs in tracks:
        if segs and isinstance(segs[0], tuple):
            segs = [segs]
        if use_route:
            out.append("<rte>")
            if tname:
                out.append(f"<name>{tname}</name>")
            for seg in segs:
                for lat, lon, e in seg:
                    ele = f"<ele>{e:.2f}</ele>" if e is not None else ""
                    out.append(f'<rtept lat="{lat:.7f}" lon="{lon:.7f}">{ele}</rtept>')
            out.append("</rte>")
            continue
        out.append("<trk>")
        if tname:
            out.append(f"<name>{tname}</name>")
        for seg in segs:
            out.append("<trkseg>")
            for lat, lon, e in seg:
                ele = f"<ele>{e:.2f}</ele>" if e is not None else ""
                out.append(f'<trkpt lat="{lat:.7f}" lon="{lon:.7f}">{ele}</trkpt>')
            out.append("</trkseg>")
        out.append("</trk>")
    out.append("</gpx>")
    return "\n".join(out).encode()


def loop_points(center=(51.0, 4.4), radius_m=2000.0, n=400, ele=None):
    """Closed circle; start == end."""
    pts = []
    for i in range(n + 1):
        a = 2 * math.pi * i / n
        lat, lon = offset(center[0], center[1], radius_m * math.cos(a), radius_m * math.sin(a))
        pts.append((lat, lon, None if ele is None else ele(i)))
    return pts
