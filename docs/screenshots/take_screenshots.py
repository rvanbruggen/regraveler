"""Retake the README screenshots.

Not part of the app: a helper for the docs. It drives Chrome with Playwright
(pip install playwright; it uses the installed Google Chrome, no browser download).

Setup (use scratch folders, not your real library):

1. A BRouter server on localhost:17777 with tiles for Flanders (see the README),
   for the surface estimates and the combiner.
2. App A, with generated names and surface estimates, on port 8766:
       DATA_DIR=/tmp/shots/data GPX_DIR=/tmp/shots/gpx python -m app.cli import /tmp/shots/gpx
       DATA_DIR=/tmp/shots/data GPX_DIR=/tmp/shots/gpx python -m app.cli estimate-surface
       DATA_DIR=/tmp/shots/data GPX_DIR=/tmp/shots/gpx SURFACE_AUTO_ESTIMATE=0 uvicorn app.main:app --port 8766
3. App B, with the original file names (for the rename screen), on port 8767: the same with
   AUTO_RENAME_ON_IMPORT=0 on import and another DATA_DIR.

Then:
    python docs/screenshots/take_screenshots.py            # all screens
    python docs/screenshots/take_screenshots.py map combine  # only some
    python docs/screenshots/take_screenshots.py --demo-metadata   # first add a few ratings/tags

Screens: library, route, rename, map, combine, restart, duplicates, import.
"""
from __future__ import annotations

import argparse
import json
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path(__file__).parent
WIDTH, HEIGHT = 1280, 800
SCALE = 1.25  # 1600 px wide images: sharp on GitHub, small files
JPEG = {"map", "combine", "change-start"}  # mostly map tiles: JPEG is much smaller

# A few ratings and tags so the library screenshot isn't empty (names from generated names).
DEMO_METADATA = [
    ("Tervuren – Kapucijnenbos", 5, ["forest", "hilly", "favourite"]),
    ("Oud-Heverlee – Sint-Joris-Weert", 5, ["forest", "hilly"]),
    ("Hoeilaart – Alsemberg – Hallebos", 4, ["forest", "hilly", "spring"]),
    ("Kemmel – Westouter", 5, ["hilly", "cobbles", "favourite"]),
    ("Gooik – Tollembeek", 4, ["hilly", "cobbles"]),
    ("Essen – Steertse Heide", 4, ["heath", "sand"]),
    ("Puurs – Ruisbroek", 3, ["river"]),
    ("Merksplas – Lege Heide", 3, ["heath", "sand"]),
    ("Herentals – Wechelderzande", 4, ["forest", "sand"]),
    ("Gent – Sleidinge", 3, ["river"]),
    ("Blauwput – Korbeek-Lo", 4, ["forest"]),
    ("Beernem – Hertsberge", 3, ["forest"]),
]


def add_demo_metadata(base: str) -> None:
    def call(path, body=None, method="GET"):
        req = urllib.request.Request(base + path, method=method, headers={"Content-Type": "application/json"},
                                     data=None if body is None else json.dumps(body).encode())
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp)

    routes = call("/api/routes")
    for prefix, rating, tags in DEMO_METADATA:
        route = next((r for r in routes if r["name"].startswith(prefix)), None)
        if route:
            call(f"/api/routes/{route['id']}", {"quality_rating": rating, "tags": tags}, "PATCH")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("screens", nargs="*", help="only these screens (default: all)")
    ap.add_argument("--base", default="http://localhost:8766", help="app with generated names")
    ap.add_argument("--rename-base", default="http://localhost:8767", help="app with the original names")
    ap.add_argument("--demo-metadata", action="store_true", help="first add a few ratings and tags")
    args = ap.parse_args()
    wanted = set(args.screens)
    if args.demo_metadata:
        add_demo_metadata(args.base)

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome")
        page = browser.new_context(viewport={"width": WIDTH, "height": HEIGHT}, device_scale_factor=SCALE,
                                   color_scheme="light", locale="nl-BE").new_page()

        def settle(ms=1500):
            page.wait_for_load_state("networkidle")
            page.wait_for_timeout(ms)

        def go(hash_="", base=args.base):
            page.goto(f"{base}/{'#' + hash_ if hash_ else ''}")
            page.reload()  # the app reads the URL hash on load
            settle()

        def route_id(prefix):
            return page.evaluate(
                f"(async () => (await api('/api/routes')).find(r => r.name.startsWith({prefix!r})).id)()")

        def shot(name):
            if name in JPEG:
                page.screenshot(path=str(OUT / f"{name}.jpg"), type="jpeg", quality=82)
            else:
                page.screenshot(path=str(OUT / f"{name}.png"))
            print("saved", name)

        def want(name):
            return not wanted or name in wanted

        if want("library"):
            go("sort=quality_rating&order=desc")
            boxes = page.locator("#routes tbody tr td.sel input")
            for i in (0, 1, 3):
                boxes.nth(i).check()
            shot("library")

        if want("route"):
            go("sort=quality_rating&order=desc")
            page.evaluate(f"openDetail({route_id('Tervuren – Kapucijnenbos')})")
            settle(2500)
            shot("route-panel")

        if want("rename"):
            go(base=args.rename_base)
            page.evaluate("openRename(routes.map(r => r.id))")
            settle(2000)
            shot("rename")

        if want("map"):
            go("view=map&near=100")
            settle(2500)
            page.evaluate("() => { overview.map.setView([50.83, 4.58], 11); }")
            settle(2500)
            shot("map")

        if want("combine"):
            go("view=combine")
            a, b = route_id("Tervuren – Kapucijnenbos"), route_id("Blauwput – Korbeek-Lo")
            page.evaluate(f"openCombiner({a}, {b})")
            settle(3000)
            page.evaluate("() => { cb.map.fitBounds(L.featureGroup(cb.resultLayer.getLayers()).getBounds(),"
                          " { padding: [50, 50] }); }")
            settle(2500)
            shot("combine")

        if want("restart"):
            go()
            go(f"view=restart&route={route_id('Oud-Heverlee – Sint-Joris-Weert')}")
            settle(2000)
            page.evaluate("""() => { const s = document.querySelector('#rs-slider');
              s.disabled = false; s.value = 430;
              s.dispatchEvent(new Event('input', {bubbles: true}));
              s.dispatchEvent(new Event('change', {bubbles: true})); }""")
            settle(3000)
            shot("change-start")

        if want("duplicates"):
            go("view=duplicates")
            settle(2000)
            shot("duplicates")

        if want("import"):
            go("view=import")
            page.evaluate("""(() => {
              const dt = new DataTransfer();
              for (const n of ['Gravelroute Hageland.gpx', 'Gravelroute Demervallei.gpx', 'Gravelroute Zoersel-Schilde.gpx'])
                dt.items.add(new File(['<gpx/>'], n));
              document.querySelector('#dropzone').dispatchEvent(new DragEvent('drop', {dataTransfer: dt, bubbles: true}));
              document.querySelector('#batch-source-name').value = 'gravelroutedatabase.be';
              document.querySelector('#batch-source-url').value = 'https://gravelroutedatabase.be/';
              document.querySelector('#batch-tags').value = 'kempen, spring';
              document.querySelectorAll('#pending tbody td:nth-child(5) input')[0].value = 'favourite';
            })()""")
            page.wait_for_timeout(500)
            shot("import")

        browser.close()


if __name__ == "__main__":
    main()
