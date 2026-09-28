#!/usr/bin/env python3
"""Build data/stations.json: the train stations the Train rides utility plans with.

From OpenStreetMap (through the Overpass API, once, here; the page never asks for them):
railway=station and railway=halt in Belgium, the Netherlands, Luxembourg, northern France and
western Germany (the box below), without metro, tram, light rail and museum lines. Each
station: [name, lat, lon, uic] (uic: the UIC code when OpenStreetMap has it; for Belgian
stations it gives the timetable id directly).

    python3 web/tools/build_stations.py [--bbox S,W,N,E]

Standard library only. © OpenStreetMap contributors, ODbL.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data" / "stations.json"
SERVERS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
# Belgium, the Netherlands, Luxembourg, Hauts-de-France / Grand Est, the west of Germany.
BBOX = (49.0, 2.0, 53.7, 7.6)
NOT_TRAINS = {"subway", "light_rail", "monorail", "funicular", "miniature", "tram"}


def query(bbox) -> dict:
    s, w, n, e = bbox
    q = (f'[out:json][timeout:300];'
         f'(node["railway"~"^(station|halt)$"]({s},{w},{n},{e});'
         f'way["railway"~"^(station|halt)$"]({s},{w},{n},{e}););'
         f'out center tags;')
    body = urllib.parse.urlencode({"data": q}).encode()
    for attempt in range(3):
        for url in SERVERS:
            try:
                req = urllib.request.Request(url, data=body, headers={"User-Agent": "rerouter build_stations.py (+https://github.com/rvanbruggen/rerouter)"})
                with urllib.request.urlopen(req, timeout=360) as resp:
                    return json.loads(resp.read())
            except Exception as err:  # noqa: BLE001 - try the next server
                print(f"{url}: {err}", file=sys.stderr)
        time.sleep(20 * (attempt + 1))
    raise SystemExit("No Overpass server answered; try again later")


def keep(tags: dict) -> bool:
    if not tags.get("name"):
        return False
    if tags.get("station") in NOT_TRAINS or tags.get("usage") == "tourism" or tags.get("tourism") == "museum":
        return False
    if tags.get("railway:historic") or tags.get("disused") == "yes" or tags.get("abandoned") == "yes":
        return False
    return tags.get("train") != "no"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bbox", default=",".join(map(str, BBOX)), help="south,west,north,east")
    args = ap.parse_args()
    bbox = tuple(float(v) for v in args.bbox.split(","))
    data = query(bbox)
    seen = set()
    stations = []
    for e in data.get("elements", []):
        tags = e.get("tags", {})
        if not keep(tags):
            continue
        lat, lon = (e["lat"], e["lon"]) if "lat" in e else (e["center"]["lat"], e["center"]["lon"])
        uic = (tags.get("uic_ref") or "").split(";")[0].strip() or None
        key = (tags["name"], round(lat, 3), round(lon, 3))
        if key in seen:
            continue
        seen.add(key)
        stations.append([tags["name"], round(lat, 5), round(lon, 5), uic])
    stations.sort(key=lambda s: (s[1], s[2]))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"source": "OpenStreetMap contributors, ODbL", "bbox": bbox, "stations": stations},
                              ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    with_uic = sum(1 for s in stations if s[3])
    print(f"{len(stations)} stations ({with_uic} with a UIC code) in {OUT} ({OUT.stat().st_size / 1000:.0f} kB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
