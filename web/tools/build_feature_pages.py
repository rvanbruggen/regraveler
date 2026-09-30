#!/usr/bin/env python3
"""Build the feature pages (web/features/) and web/sitemap.xml.

The app is one page, whose views (Library, Map, Combine, …) are chosen after the "#" in the
address, which search engines leave out. So each feature also gets a small static page of its
own, with its own address, title and text, that links into the app. The pages, the screenshots
they show (copied from docs/screenshots/) and the sitemap all come from PAGES below. Run it
after changing them:

    python3 web/tools/build_feature_pages.py

Standard library only.
"""
from __future__ import annotations

import html
import shutil
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent
FEATURES = WEB / "features"
SCREENSHOTS = WEB.parent / "docs" / "screenshots"
SITE = "https://rerouter.eu/"

# slug, the app view it opens (after "#view="), the screenshot in docs/screenshots/ (or None),
# the <title>, the meta description, the heading, the lead, and the body (HTML).
PAGES = [
    {
        "slug": "gpx-route-library",
        "view": "library",
        "shot": ("library.webp", "The library: the filter bar, the Browse panel with collections, areas and regions, and the routes"),
        "title": "A library for your GPX routes: gravel, road, MTB and hiking",
        "description": "Keep all your gravel, road, mountain bike and hiking routes in one library: filter by distance, climbing and paved %, and browse by collection, area and region.",
        "h1": "A library for all your routes",
        "lead": "Keep your gravel, road, mountain biking and hiking routes in one place, and find the right one again in seconds.",
        "body": """
<ul>
  <li><strong>Filter</strong> by name or notes, distance, elevation gain, paved %, your own quality rating (1–5) and tags.</li>
  <li><strong>Browse</strong> by activity, source, loop or point to point, and by <strong>collections</strong> (one inside another, such as <em>Trips › Ardennes</em>), <strong>smart collections</strong> (saved filters that keep themselves up to date), <strong>areas</strong> you draw yourself, and <strong>regions</strong> (e.g. <em>Vlaanderen › Vlaams-Brabant</em>).</li>
  <li><strong>A panel per route:</strong> its map, stats, an elevation profile with the climbs coloured by gradient, the surface (paved, cobbles, unpaved) from OpenStreetMap, the places along it, your notes and rating.</li>
  <li><strong>Names that say where you ride:</strong> rerouter suggests a name after the start town and the places the route visits, such as <em>Tervuren – Kapucijnenbos – Duisburg – Hogenbos</em>.</li>
  <li>Select several routes to tag them, put them in a collection, download them as GPX or export them as a set for another library.</li>
</ul>
""",
    },
    {
        "slug": "import-gpx-tcx-fit",
        "view": "import",
        "shot": ("import.webp", "Import: a batch of route files with the source, activity and tags for the whole batch"),
        "title": "Import GPX, TCX and FIT route files",
        "description": "Drop GPX, TCX and FIT files, folders or zips (even a Strava bulk export) into rerouter: distance, climbing, a name and the surface are worked out for you.",
        "h1": "Import GPX, TCX and FIT files",
        "lead": "Drag and drop your route files, many at once, whole folders or zip files, and rerouter does the rest.",
        "body": """
<ul>
  <li><strong>GPX, TCX and FIT</strong> from Garmin, Wahoo and other bike computers and watches, also gzip-compressed as in a Strava bulk export. Your original files are kept as they are.</li>
  <li><strong>Worked out for you:</strong> distance, elevation gain and loss, whether it is a loop, a name after the places it visits and, if you like, how much of it is paved (from OpenStreetMap).</li>
  <li><strong>Source, activity and tags</strong> for the whole batch, with an override per file. A file that says it is a run or walk becomes hiking.</li>
  <li><strong>No duplicates:</strong> the same file or the same track is skipped; very similar routes are imported but flagged.</li>
  <li><strong>Recorded rides:</strong> a ride you recorded that covers a route you already have can be logged on that route instead of being imported again.</li>
  <li>Just looking around? Add one of the example route sets with one click.</li>
</ul>
""",
    },
    {
        "slug": "import-from-komoot-ridewithgps-strava",
        "view": "link",
        "shot": None,
        "title": "Import a route from a Komoot, RideWithGPS or Strava link",
        "description": "Paste a link to a Komoot tour, a RideWithGPS route or a Strava route and rerouter adds it to your library, with its name, description and activity.",
        "h1": "Import a route from a link",
        "lead": "Paste a link to a route online and rerouter fetches it, fills in the source, activity and description, and adds it to your library.",
        "body": """
<ul>
  <li><strong>Komoot</strong> tours, if public, or private ones shared with you by a link. Komoot's “gravel ride” becomes Gravel.</li>
  <li><strong>RideWithGPS</strong> routes and rides, if public.</li>
  <li>For Komoot and RideWithGPS, their surface figure can be used as the route's paved %.</li>
  <li><strong>Strava</strong> only hands out a route's GPX to someone signed in: rerouter gives you the export link, you download the file and choose it, and it is imported with the Strava link as its source.</li>
  <li><strong>Any other link to a GPX file</strong> is imported as it is, when the site allows it.</li>
</ul>
<p>The route is then imported like any GPX file: named after the places it visits (the original name goes into the notes) and checked for duplicates.</p>
""",
    },
    {
        "slug": "combine-routes",
        "view": "combine",
        "shot": ("combine.webp", "Combine: parts of two routes, with the connectors routed between them"),
        "title": "Combine GPX routes into a new ride",
        "description": "Pick the parts of 2 to 4 routes you want to ride, say which follows which, and rerouter joins them into a new route, with the connectors routed for you by BRouter. Download the GPX.",
        "h1": "Combine routes into a new ride",
        "lead": "Like the first half of one route and the second half of another? Pick the parts you want to ride and rerouter joins them, with the connectors routed for you.",
        "body": """
<ol>
  <li>Choose 2 to 4 routes: select them in your library, tick them in a list you can narrow down by collection, area, region or name, click them on the map, or start from a route's panel.</li>
  <li>Mark the <strong>parts</strong> to keep: click where each part starts and ends on its route, and drag the ends to adjust them. One route can give several parts.</li>
  <li><strong>Connect</strong> them: click the end of one part, then the start of the next, or let rerouter pick the order with the shortest gaps, as a loop or point to point.</li>
  <li>The gaps are filled with connectors routed by <a href="https://brouter.de/">BRouter</a>, with a profile for the activity (gravel, road, mountain biking or hiking; for gravel optionally preferring unpaved paths). Check each one: accept it, or pick another of BRouter's routes, a straight line, or one of your places to ride through.</li>
  <li>Check the distance, the climbing and <strong>your ride</strong> described step by step, then save it as a new route or download the GPX for your bike computer.</li>
</ol>
<p>Your original routes are never changed. On the <a href="route-map.html">map</a>, <em>Highlight routes near each other</em> shows where your routes meet: good places to combine them.</p>
""",
    },
    {
        "slug": "change-start-point",
        "view": "restart",
        "shot": ("change-start.webp", "Change start point: a 203 km loop, now starting in Rijkevorsel"),
        "title": "Change the start point of a loop route (GPX)",
        "description": "Start a GPX loop somewhere else: click where it should start, see the new first kilometre and the town it starts in, and download the new GPX.",
        "h1": "Start a loop somewhere else",
        "lead": "A great loop that starts on the other side of the map? Move its start to where you live, park or get off the train.",
        "body": """
<ul>
  <li>Choose a loop, then click where it should start (clicks snap onto the route), drag the start marker or use the slider.</li>
  <li>The preview shows the stats, the town where it now starts and the first kilometre in green, so you see the riding direction. One click rides it the other way round.</li>
  <li>Download the GPX, or save it as a new route that keeps the original's tags, activity, rating and source, linked to the original.</li>
</ul>
""",
    },
    {
        "slug": "ride-weather",
        "view": "weather",
        "shot": ("weather.webp", "Ride weather: a calendar with the forecast per day, and the route coloured by head- and tailwind"),
        "title": "Ride weather: the forecast and wind along your route",
        "description": "The weather along your route for the day and time you ride: temperature, rain, and where you have headwind or tailwind, with the best start time.",
        "h1": "The weather along your route",
        "lead": "Not the weather at home, but along the route, at the moment you pass each point: so you know when to start, and which way round to ride.",
        "body": """
<ul>
  <li>Pick the day in a calendar with the weather per day (today and the next 15 days), your start time and average speed.</li>
  <li>See the temperature range, the rain expected on the way and its chance, the wind and gusts, and how many km you ride into the wind or with it behind you.</li>
  <li>The map colours the route by <strong>headwind</strong>, <strong>crosswind</strong> and <strong>tailwind</strong>, with wind arrows.</li>
  <li>A table compares start times from 06:00 to 20:00, and when riding the route the other way round is clearly easier on the wind, rerouter says so.</li>
</ul>
<p>The forecast comes from <a href="https://open-meteo.com/">Open-Meteo</a>; only a few points along the route are sent.</p>
""",
    },
    {
        "slug": "places-along-a-route",
        "view": "findplaces",
        "shot": ("places.webp", "Places: example lists to add, your lists and categories, and the places table"),
        "title": "Cafés, water and toilets along your cycling route",
        "description": "Find the cafés, water taps, toilets, stations and bike shops along a route, from your own places and OpenStreetMap, and add them to the GPX as waypoints.",
        "h1": "Cafés, water and toilets along your route",
        "lead": "Where can you get a coffee, fill your bottles or find a toilet on the way? rerouter lists the places along a route, in riding order.",
        "body": """
<ul>
  <li><strong>Your own places</strong>, imported from Google My Maps or a CSV file, from the waypoints in your GPX files, or clicked on the map, and ready-made example lists.</li>
  <li><strong>Places from OpenStreetMap</strong>: water, toilets, bike repair, stations, shelters, viewpoints and more, within 100 m to 2 km of the route.</li>
  <li>Each place with the km where you pass it and how far off the route it is, on the map and in a list.</li>
  <li>Make a new route with the places you pick: as <strong>GPX waypoints</strong> your bike computer shows along the way, or with <strong>detours</strong> routed through them.</li>
</ul>
""",
    },
    {
        "slug": "train-rides",
        "view": "trains",
        "shot": None,
        "title": "Bike and train: plan a day out with your own routes",
        "description": "Plan a day out by bike and train in Belgium, the Netherlands and around: ride out and take the train back, or the other way round, with your own routes.",
        "h1": "A day out with the train",
        "lead": "Ride out and take the train home, or take the train out and ride back: rerouter finds the routes in your library that fit, and the trains that go with them.",
        "body": """
<ul>
  <li>Four kinds of trip: <strong>ride out, train back</strong>; <strong>train out, ride home</strong>; <strong>train out and back</strong> (station to station); and <strong>a loop from a station</strong>.</li>
  <li>Choose the date, when you leave home, the most transfers you accept, how far a route may lie from a station, the riding km and your speed.</li>
  <li>Stations in Belgium, the Netherlands, Luxembourg, the north of France and the west of Germany; timetables from <a href="https://transitous.org/">Transitous</a>, with <a href="https://irail.be/">iRail</a> between Belgian stations.</li>
  <li>Each trip shows its trains and transfers, the riding km and climbing, and when you are back home. Check the <a href="ride-weather.html">ride weather</a> for it, or save the riding part as a route.</li>
</ul>
<p>A bike on a train needs a ticket of its own, and not every train or station suits a bike: check before you go.</p>
""",
    },
    {
        "slug": "route-map",
        "view": "map",
        "shot": ("map.webp", "The map: routes of one source on the grey map, the Browse panel beside it and the layer button open"),
        "title": "All your routes on one map: OpenStreetMap, CyclOSM, topo",
        "description": "See all your gravel, road, MTB and hiking routes on one map, in the map style you like, and find where routes meet to combine them.",
        "h1": "All your routes on one map",
        "lead": "Every route that matches your filters on one map: see where you have ridden, and where your routes meet.",
        "body": """
<ul>
  <li><strong>Map styles:</strong> OpenStreetMap, CyclOSM (with unpaved roads), OpenTopoMap (contour lines), the Belgian NGI topo map and satellite, with the signposted hiking and cycling routes as overlays. <strong>Grey map</strong> makes your routes stand out.</li>
  <li><strong>Routes near each other:</strong> shows where routes overlap or come close, with the shared km: good starting points to <a href="combine-routes.html">combine two routes</a>.</li>
  <li>Your places and areas on the same map; draw an area or add a place with a click.</li>
  <li>The filters and the view are kept in the address, so a bookmark brings back the same map.</li>
</ul>
""",
    },
    {
        "slug": "share-routes",
        "view": "library",
        "shot": ("route-panel.webp", "A route's panel: its map, the elevation profile with the climbs coloured, stats and details"),
        "title": "Share a GPX route with a link, without uploading it",
        "description": "Share a route with a link that holds the route itself: a map, stats, surface and elevation profile, with a GPX download. Nothing is uploaded.",
        "h1": "Share a route with a link",
        "lead": "Send a friend a link to a route: they see it on a map with its stats, and can download the GPX or add it to their own library.",
        "body": """
<ul>
  <li><strong>The route is in the link itself</strong>, after the <code>#</code>, which browsers never send to a server: nothing is uploaded or stored.</li>
  <li>The shared page shows the map, stats, surface and elevation profile, with <em>Download GPX</em> and <em>Add to my library</em>.</li>
  <li><strong>Privacy:</strong> set your home, and shared routes leave out their start and end near it.</li>
  <li>Your notes and the source link only go along when you tick them.</li>
  <li>To share many routes at once, export them as a set: a zip that another rerouter library adds without replacing anything.</li>
</ul>
""",
    },
    {
        "slug": "duplicate-routes",
        "view": "duplicates",
        "shot": ("duplicates.webp", "Duplicates: the same routes from two sites, with a suggestion which one to keep"),
        "title": "Find and clean up duplicate GPX routes",
        "description": "Find the routes you have twice, such as the same route from two sites, and the short loops that lie on a longer one, with a suggestion which to keep.",
        "h1": "Clean up duplicate routes",
        "lead": "Downloaded the same route from two sites? rerouter finds the routes you have twice and suggests which one to keep.",
        "body": """
<ul>
  <li>Groups of near-duplicate routes, with the overlap, source, rating and tags of each, and hints such as “identical track” or “ridden the other way”.</li>
  <li>A suggestion which one to keep: the one with most of your own ratings, tags and notes, then the oldest.</li>
  <li>Remove the ones you tick, show them on the map, or mark them as <em>not duplicates</em>.</li>
  <li><strong>Variants:</strong> routes that lie (almost) entirely on a longer route, such as a short loop inside a long one.</li>
</ul>
""",
    },
]

HUB = {
    "title": "Features: a route manager for gravel, road, MTB and hiking",
    "description": "What rerouter does: a library for your GPX routes, import from Komoot and RideWithGPS, combine routes, ride weather, places along a route and train rides.",
    "h1": "What rerouter does",
    "lead": "rerouter is a free route manager that runs in your browser: keep your gravel, road, mountain biking and hiking routes in one library, and do in one click what riders keep doing by hand.",
}

CSS = """\
:root { --bg: #f6f6f3; --panel: #ffffff; --text: #222; --muted: #6b6b6b; --border: #d9d9d2; --accent: #b35c1e; --accent-soft: #f6e7db; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--text); background: var(--bg); }
header { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 24px; padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--border); }
.brand { display: flex; align-items: center; gap: 8px; color: inherit; text-decoration: none; font-weight: 600; font-size: 24px; letter-spacing: -0.5px; }
.brand .re { color: var(--accent); }
header nav { margin-left: auto; display: flex; gap: 16px; font-size: 15px; }
main { max-width: 860px; margin: 0 auto; padding: 24px 16px 40px; }
h1 { font-size: 32px; line-height: 1.2; margin: 8px 0 12px; }
h2 { font-size: 22px; margin: 32px 0 8px; }
.lead { font-size: 19px; color: #444; margin: 0 0 20px; }
a { color: var(--accent); }
li { margin: 0 0 8px; }
figure { margin: 24px 0; }
figure img { display: block; width: 100%; height: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
figcaption { font-size: 14px; color: var(--muted); margin-top: 6px; }
.cta { display: inline-block; margin: 8px 0 4px; padding: 10px 18px; border-radius: 6px; background: var(--accent); color: #fff; text-decoration: none; font-weight: 600; }
.cta:hover { filter: brightness(1.08); }
.note { font-size: 14px; color: var(--muted); }
.cards { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.cards li { margin: 0; }
.cards a { display: block; height: 100%; padding: 14px 16px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; color: inherit; text-decoration: none; }
.cards a:hover { border-color: var(--accent); }
.cards strong { display: block; color: var(--accent); margin-bottom: 4px; }
.cards span { font-size: 14px; color: var(--muted); }
footer { padding: 16px; font-size: 13px; color: var(--muted); text-align: center; border-top: 1px solid var(--border); }
footer a { color: var(--muted); }
"""

LOGO = '<img src="../logo.svg" alt="" width="36" height="36">'


def esc(s: str) -> str:
    return html.escape(s, quote=True)


def page(*, path: str, title: str, description: str, h1: str, lead: str, content: str, jsonld: str) -> str:
    url = SITE + path
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <!-- Made by web/tools/build_feature_pages.py: change it there. -->
  <title>{esc(title)} · rerouter</title>
  <meta name="description" content="{esc(description)}">
  <link rel="canonical" href="{url}">
  <link rel="icon" href="../favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="features.css">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="rerouter">
  <meta property="og:title" content="{esc(title)}">
  <meta property="og:description" content="{esc(description)}">
  <meta property="og:url" content="{url}">
  <meta property="og:image" content="{SITE}og-image.jpg">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <script type="application/ld+json">
{jsonld}
  </script>
</head>
<body>
<header>
  <a class="brand" href="../">{LOGO}<span><span class="re">re</span>router</span></a>
  <nav><a href="index.html">Features</a><a href="../#view=about">About</a><a href="../">Open rerouter</a></nav>
</header>
<main>
  <h1>{esc(h1)}</h1>
  <p class="lead">{esc(lead)}</p>
{content}
</main>
<footer>
  rerouter is free and open source (<a href="https://github.com/rvanbruggen/rerouter">GitHub</a>) and runs in your browser: your routes stay on your device.
  Maps © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors.
</footer>
</body>
</html>
"""


def breadcrumbs(items: list[tuple[str, str]]) -> dict:
    return {
        "@type": "BreadcrumbList",
        "itemListElement": [{"@type": "ListItem", "position": i + 1, "name": n, "item": SITE + p} for i, (n, p) in enumerate(items)],
    }


def jsonld(obj: dict) -> str:
    import json
    text = json.dumps({"@context": "https://schema.org", **obj}, ensure_ascii=False, indent=2)
    return "\n".join("  " + line for line in text.splitlines())


def feature_page(p: dict) -> str:
    parts = [p["body"].strip()]
    if p["shot"]:
        file, alt = p["shot"]
        parts.append(f'<figure>\n  <img src="img/{file}" alt="{esc(alt)}" loading="lazy">\n  <figcaption>{esc(alt)}</figcaption>\n</figure>')
    parts.append(
        f'<p><a class="cta" href="../#view={p["view"]}">Open it in rerouter</a></p>\n'
        '<p class="note">Free, nothing to install, no account: your routes stay in your browser.</p>'
    )
    others = [q for q in PAGES if q is not p]
    parts.append("<h2>More of what rerouter does</h2>\n" + cards(others))
    content = "\n".join("  " + line if line else line for line in "\n".join(parts).splitlines())
    path = f"features/{p['slug']}.html"
    ld = jsonld({"@graph": [
        {"@type": "WebPage", "name": p["title"], "description": p["description"], "url": SITE + path},
        breadcrumbs([("rerouter", ""), ("Features", "features/"), (p["h1"], path)]),
    ]})
    return page(path=path, title=p["title"], description=p["description"], h1=p["h1"], lead=p["lead"], content=content, jsonld=ld)


def cards(pages: list[dict]) -> str:
    items = "\n".join(
        f'  <li><a href="{q["slug"]}.html"><strong>{esc(q["h1"])}</strong><span>{esc(q["lead"])}</span></a></li>' for q in pages
    )
    return f'<ul class="cards">\n{items}\n</ul>'


def hub_page() -> str:
    content = "\n".join("  " + line for line in (
        cards(PAGES) + '\n<p><a class="cta" href="../">Open rerouter</a></p>\n'
        '<p class="note">Free, nothing to install, no account: your routes stay in your browser. '
        'You can also run it on your own server; see <a href="https://github.com/rvanbruggen/rerouter">GitHub</a>.</p>'
    ).splitlines())
    ld = jsonld({"@graph": [
        {"@type": "CollectionPage", "name": HUB["title"], "description": HUB["description"], "url": SITE + "features/"},
        breadcrumbs([("rerouter", ""), ("Features", "features/")]),
    ]})
    return page(path="features/", title=HUB["title"], description=HUB["description"], h1=HUB["h1"], lead=HUB["lead"], content=content, jsonld=ld)


def sitemap() -> str:
    urls = [SITE, SITE + "features/"] + [f"{SITE}features/{p['slug']}.html" for p in PAGES]
    body = "\n".join(f"  <url>\n    <loc>{u}</loc>\n  </url>" for u in urls)
    return f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{body}\n</urlset>\n'


def main() -> None:
    img = FEATURES / "img"
    img.mkdir(parents=True, exist_ok=True)
    shots = {p["shot"][0] for p in PAGES if p["shot"]}
    for old in img.iterdir():
        if old.name not in shots:
            old.unlink()
    for name in sorted(shots):
        shutil.copyfile(SCREENSHOTS / name, img / name)
    for old in FEATURES.glob("*.html"):
        old.unlink()
    (FEATURES / "features.css").write_text(CSS, encoding="utf-8")
    (FEATURES / "index.html").write_text(hub_page(), encoding="utf-8")
    for p in PAGES:
        (FEATURES / f"{p['slug']}.html").write_text(feature_page(p), encoding="utf-8")
    (WEB / "sitemap.xml").write_text(sitemap(), encoding="utf-8")
    print(f"{len(PAGES)} feature pages, the index and {len(shots)} screenshots in {FEATURES}; sitemap.xml with {len(PAGES) + 2} addresses")


if __name__ == "__main__":
    main()
