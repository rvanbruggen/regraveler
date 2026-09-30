"""Retake the README screenshots.

Not part of the app: a helper for the docs. It drives Chrome with Playwright
(pip install playwright; it uses the installed Google Chrome, no browser download).

Setup (use scratch folders, not your real library):

1. A BRouter server on localhost:17777 with tiles for Flanders (see the README), for the
   surface estimates and the combiner. The rerouter servers pass the page's BRouter requests
   on to it (BROUTER_URL, default http://localhost:17777).
2. Two rerouter servers on scratch folders, both with the GPX files in /tmp/shots/gpx:
       DATA_DIR=/tmp/shots/data-a GPX_DIR=/tmp/shots/gpx uvicorn app.main:app --port 8766
       DATA_DIR=/tmp/shots/data-b GPX_DIR=/tmp/shots/gpx uvicorn app.main:app --port 8767
   App A (8766) gets generated names and surface estimates; app B (8767) keeps the original
   file names, for the rename screen.
3. Fill both libraries, once. Either let the script import the files through the page:
       python docs/screenshots/take_screenshots.py --seed --demo-metadata
   --seed adds the files in the servers' GPX folder with the Import screen's "Add them to the
   list"; --seed DIR uploads the GPX files of DIR instead. App A waits for the surface
   estimates; on app B generated names and surface estimates are switched off first.
   Libraries that already have routes are left alone.
   Or restore backup zips: --restore A.zip --rename-restore B.zip (or, before starting a
   server, DATA_DIR=... GPX_DIR=... python -m app.cli restore A.zip).

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

# The page is an ES module and keeps its Leaflet maps to itself. Keep every map it makes in
# window.__maps (by container id), so the script can move them. Leaflet sets window.L when it
# has loaded, before the page's module runs.
MAP_HOOK = """(() => {
  let leaflet;
  Object.defineProperty(window, "L", {
    configurable: true, enumerable: true,
    get: () => leaflet,
    set: (v) => {
      leaflet = v;
      v?.Map?.addInitHook(function () { (window.__maps ||= {})[this.getContainer().id] = this; });
    },
  });
})()"""

# The page's service module (web/js/service.js); the same URL gives the same module instance.
SVC = "await import(new URL('js/service.js', document.baseURI).href)"


def restore(base: str, zip_path: str) -> None:
    """Replace a server's library with a backup zip."""
    req = urllib.request.Request(f"{base}/api/restore", data=Path(zip_path).read_bytes(), method="POST",
                                 headers={"Content-Type": "application/zip"})
    with urllib.request.urlopen(req, timeout=600) as resp:
        res = json.load(resp)
    print(f"{base}: restored {res['routes']} routes")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("screens", nargs="*", help="only these screens (default: all)")
    ap.add_argument("--base", default="http://localhost:8766", help="app with generated names")
    ap.add_argument("--rename-base", default="http://localhost:8767", help="app with the original names")
    ap.add_argument("--seed", nargs="?", const="", metavar="DIR",
                    help="first import GPX files through the page into empty libraries: "
                         "the files in the servers' GPX folder, or those in DIR")
    ap.add_argument("--restore", metavar="ZIP", help="first restore this backup on --base")
    ap.add_argument("--rename-restore", metavar="ZIP", help="first restore this backup on --rename-base")
    ap.add_argument("--demo-metadata", action="store_true", help="first add a few ratings and tags")
    args = ap.parse_args()
    wanted = set(args.screens)
    if args.restore:
        restore(args.base, args.restore)
    if args.rename_restore:
        restore(args.rename_base, args.rename_restore)

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome")
        context = browser.new_context(viewport={"width": WIDTH, "height": HEIGHT}, device_scale_factor=SCALE,
                                      color_scheme="light", locale="nl-BE")
        context.add_init_script(MAP_HOOK)
        page = context.new_page()

        def settle(ms=1500):
            page.wait_for_load_state("networkidle")
            page.wait_for_timeout(ms)

        def go(hash_="", base=args.base):
            page.goto(f"{base}/{'#' + hash_ if hash_ else ''}")
            page.reload()  # the app reads the URL hash on load
            # The library has loaded once the route count is shown.
            page.wait_for_function("document.querySelector('#count').textContent.includes('route')")
            settle()

        def svc(body, arg=None):
            """Run `body` in the page with `svc` (the page's service module) and `arg`."""
            return page.evaluate(f"async (arg) => {{ const svc = {SVC}; {body} }}", arg)

        def route_id(prefix):
            rid = svc("return svc.library().all().find((r) => r.name.startsWith(arg))?.id ?? null;", prefix)
            if rid is None:
                raise SystemExit(f"No route whose name starts with {prefix!r} at {page.url}")
            return rid

        def seed(base, generated_names):
            go("view=import", base)
            count = svc("return svc.library().all().length;")
            if count:
                print(f"{base}: already has {count} routes, not seeding")
                return
            if not generated_names:
                # Settings are stored with the library; the page reads them at start-up.
                page.evaluate("""async () => {
                  const res = await fetch('api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ settings: { AUTO_RENAME_ON_IMPORT: false, SURFACE_AUTO_ESTIMATE: false } }) });
                  if (!res.ok) throw new Error(`settings: HTTP ${res.status}`);
                }""")
                go("view=import", base)
            if args.seed:
                files = sorted(str(f) for f in Path(args.seed).expanduser().rglob("*") if f.suffix.lower() == ".gpx")
                if not files:
                    raise SystemExit(f"No GPX files in {args.seed}")
                page.set_input_files("#file-input", files)
            else:
                button = page.locator("#disk-import-btn")
                try:
                    button.wait_for(state="visible", timeout=15_000)
                except Exception:
                    raise SystemExit(f"{base}: no GPX files in the server's GPX folder to add") from None
                button.click()
            page.wait_for_function("!document.querySelector('#import-btn').disabled", timeout=0)
            page.click("#import-btn")
            page.wait_for_selector("#import-results h3", timeout=0)
            print(f"{base}: {page.locator('#import-results h3').text_content()}")
            if generated_names:
                print(f"{base}: waiting for the surface estimates…")
                svc("window.__svc = svc;")
                page.wait_for_function("!window.__svc.surfaceJob.status().running", timeout=0, polling=2000)
                print(f"{base}: {page.locator('#surface-job').text_content().strip(' ·')}")

        if args.seed is not None:
            seed(args.base, generated_names=True)
            seed(args.rename_base, generated_names=False)

        if args.demo_metadata:
            go()
            svc("""const all = svc.library().all();
              for (const [prefix, rating, tags] of arg) {
                const r = all.find((r) => r.name.startsWith(prefix));
                if (r) await svc.updateRoute(r.id, { quality_rating: rating, tags });
              }""", DEMO_METADATA)

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
            page.click(f"#routes tbody tr[data-id='{route_id('Tervuren – Kapucijnenbos')}'] td:nth-child(2)")
            settle(2500)
            shot("route-panel")

        if want("rename"):
            go(base=args.rename_base)
            page.click("#suggest-names")
            page.wait_for_selector("#rn-table tbody tr", timeout=0)
            settle(2000)
            shot("rename")

        if want("map"):
            go("view=map&near=100")
            settle(2500)
            page.evaluate("() => { window.__maps['overview-map'].setView([50.83, 4.58], 11); }")
            settle(2500)
            shot("map")

        if want("combine"):
            go()
            a, b = route_id("Tervuren – Kapucijnenbos"), route_id("Blauwput – Korbeek-Lo")
            # Parts for "A, then B": A from its start to where it comes closest to B, then B
            # from there to its end (closest points of the two routes' geometries, keeping at
            # least 30 % of each route so neither part is empty).
            parts = svc("""const [ra, rb] = arg.map((id) => svc.library().get(id));
              const d = (p, q) => Math.hypot(p[0] - q[0], (p[1] - q[1]) * Math.cos(p[0] * Math.PI / 180));
              let best = [Infinity, 0, 0];
              const na = ra.geometry.length, nb = rb.geometry.length;
              ra.geometry.forEach((p, i) => rb.geometry.forEach((q, j) => {
                if (i < 0.3 * (na - 1) || j > 0.7 * (nb - 1)) return; // keep at least 30 % of each route
                const x = d(p, q); if (x < best[0]) best = [x, i, j];
              }));
              const pt = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
              return [`${ra.id}:${pt(ra.geometry[0])}:${pt(ra.geometry[best[1]])}`,
                      `${rb.id}:${pt(rb.geometry[best[2]])}:${pt(rb.geometry[rb.geometry.length - 1])}`];""", [a, b])
            go(f"view=combine&routes={a},{b}&part={parts[0]}&part={parts[1]}&links=0-1&step=ride")
            # Wait for the connection to be routed, then accept it.
            page.wait_for_function("!document.querySelector('#cb-accept-all').disabled", timeout=60000)
            page.click("#cb-accept-all")
            settle(1000)
            # Zoom to the result: its legs are the thick lines on the combine map.
            page.evaluate("""() => { const m = window.__maps['combine-map'], legs = [];
              m.eachLayer((l) => { if (l instanceof L.Polyline && l.options.weight >= 5) legs.push(l); });
              if (!legs.length) throw new Error(`no combined route: ${document.querySelector('#cb-status').textContent}`);
              m.fitBounds(L.featureGroup(legs).getBounds(), { padding: [50, 50] }); }""")
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
            })()""")
            # The dropped files are read asynchronously: wait for the list, then add a per-file tag.
            page.wait_for_selector("#pending tbody tr")
            page.evaluate("document.querySelector('#pending tbody td:nth-child(5) input').value = 'favourite'")
            page.wait_for_timeout(500)
            shot("import")

        browser.close()


if __name__ == "__main__":
    main()
