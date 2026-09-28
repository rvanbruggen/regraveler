# rerouter roadmap (after 0.13.0)

Agreed order, 2026-09-28. Each item ships as its own minor release (`/bump minor`).

| # | Item | Effort | Storage contract change? |
|---|---|---|---|
| 1 | Elevation profile | S | no |
| 2 | TCX and FIT import (+ recognising recorded rides) | M | yes: non-GPX originals |
| 3 | POIs and marks (own + OpenStreetMap) | M–L | yes: generic document store |
| 4 | Catalog: collections, smart collections, browse by group | M | uses the store from 3 |
| 5 | Share link (no accounts) + privacy zones + home location | S–M | no (home location is a setting) |
| 6 | Ride log and wishlist | S | no |
| 7 | Train rides | L | no (uses home + stations + POIs) |

Dropped for now: multi-user hosting, comments and sharing between users, mud check, combining N
routes, route editor, PWA, TCX/FIT course export.

---

## Cross-cutting groundwork

Found while validating (facts from the code as of 0.13.0):

- **Only four stores exist:** routes, files, ignored pairs and settings (`web/js/db.js:17`). Each
  has its own endpoints in `app/main.py`, its own branches in `web/js/remote.js`, and its own
  section in the backup. There is no generic document store.
  - Route documents are schema-free JSON (`RouteDoc.data`), so **new route fields** (ride log,
    wishlist) need no server change.
- **Originals are GPX everywhere:**
  - `_safe_filename` forces `.gpx` (`app/store.py:128`), and the disk scan only reads `*.gpx`.
  - Backups use `gpx/<hash>.gpx`, and content types are `application/gpx+xml`.
  - `importGpx` always calls `parseGpx`.

Two storage changes, each done when it is first needed:

**G1 — Non-GPX originals (with item 2).** Keep the rule "originals are never modified": store
the `.fit`/`.tcx` bytes as they are.
- The route gets a `file_format` field.
- The server keeps the real extension, and `/api/files/{hash}` returns a content type that
  matches it.
- The backup keeps the `gpx/` folder name for compatibility, but files keep their own
  extension there (`gpx/<hash>.fit`). Restore goes by extension.
- *Download original* gives the original file. *Download GPX* writes a GPX from the parsed points.
- One reader `parseTrackFile(bytes, name)` dispatches to gpx/tcx/fit, and the rest of the code
  keeps its `{name, tracks:[{points}]}` shape.

**G2 — Generic document store (with item 3).** Don't add a store per feature. Add one
`docs` store keyed by `(kind, id)` (IndexedDB store + one `library_docs` table + `GET/PUT/DELETE
/api/docs/{kind}`), used by POIs (`kind: "poi"`) and collections (`kind: "collection"`), and
later trips. Backups get a `docs` key, and the backup `version` goes to 2 (version 1 still
restores). The small alternative, one JSON value per settings key, doesn't scale to hundreds
of POIs, and every edit would rewrite the whole list.

---

## 1. Elevation profile

**What:** an elevation chart in the route panel. Hovering it shows a marker on the panel map, and
hovering the map line highlights the chart. It shows km, elevation, and the gradient of the
current stretch. Later it also goes in the combine preview, change-start and the share page.

**Technical validation**
- The data is there. `svc.loadTrack(r)` (`service.js:564`) gives the full-resolution track with
  elevation and cumulative distance (LRU-cached). `smoothedProfile()` (`stats.js:36`) already
  gives the 10 m resampled, smoothed profile used for elevation gain, so the chart matches the
  numbers.
- Stored `geometry` has no elevation, so the chart is loaded asynchronously in
  `openDetail` (`app.js:618`), like `loadSimilar`. It goes after `#d-stats` (`index.html:506`).
- Drawn as own inline SVG (no chart library, no new dependency). Downsample to ~1 point per
  pixel with min/max per bucket so short steep bits stay visible.
- Colour the gradient bands (0–3–6–9 %+), and optionally surface underneath (we have
  `surface.segments`).
- Routes without `<ele>`: hide the chart and show "no elevation in this file".

**Tests:** downsampling keeps the min/max, the distance ↔ index lookup for hover, and gradient per stretch.

---

## 2. TCX and FIT import

**What:** import `.tcx`, `.fit` and `.fit.gz` next to `.gpx`, in drag and drop, folders, zips and
link import. It also takes a **Strava bulk export** (its `activities/` folder is a mix of
`.gpx`, `.tcx.gz` and `.fit.gz`).

**Technical validation**
- **TCX** is XML. Our own `parseXml` (`gpx.js:25`) already runs in the browser, workers and Node,
  so a TCX reader is small:
  - read `Trackpoint/Position/LatitudeDegrees|LongitudeDegrees` and `AltitudeMeters`;
  - handle `Activities/Activity` (a recorded ride) and `Courses/Course` (a planned route);
  - keep `CoursePoint`s as candidate POIs (item 3).
- **FIT** is binary, so we write our own decoder (`web/js/fit.js`, est. 250–350 lines, keeping
  the no-npm rule). It needs to handle:
  - the 12/14-byte header;
  - definition and data messages with local message types;
  - both byte orders;
  - compressed-timestamp headers;
  - developer fields, which we skip by their declared size;
  - CRC (check it, but still import if it's wrong).

  Messages we read:
  - `file_id` (type 4 = activity, 6 = course);
  - `record` (msg 20): position_lat/long in semicircles (×180/2³¹), altitude (field 2, scale 5,
    offset 500) or enhanced_altitude (field 78), timestamp;
  - `course` (31) for the name;
  - `session` (18) for the sport, mapped to the activity (cycling/gravel → gravel,
    road → road, mountain → MTB, hiking/walking → hiking);
  - `course_point` (32) as candidate POIs.
- **`.gz`:** `DecompressionStream('gzip')` exists in browsers and in Node ≥ 18, so no dependency.
- **Needs G1** (store originals as-is), including the server's `_safe_filename`, disk scan and
  `/api/disk-files/content`.
- **Recognising recorded rides:**
  - A FIT/TCX *activity* is a ride you did, not a planned route. On import, rerouter
    simplifies it and runs `findSimilar()` (`similarity.js:60`) against the library.
  - If ≥ 80 % of the ride lies on one route, the import screen says "this is *X*, ridden on
    2026-09-14" and offers *Log as ridden* (the default) or *Import as a new route*.
  - The date comes from the first timestamp. The log is kept on the route (see item 6), so
    item 2 already writes `rides: [{date, file_hash}]` and item 6 builds the UI on it.

**Validated on Rik's sample files (2026-09-28)**, with a throwaway Python decoder:

| File | Device | Type | Sport | Points | Notes |
|---|---|---|---|---|---|
| `Gravel_voor_de_Koers_van_Toon_.fit` | Wahoo (manufacturer 32) | activity (4) | cycling / generic | 7625 | **77 developer-field definitions**, manufacturer messages 65280–65285, little-endian |
| `The_stoofvlees_digestion_project.fit` | Garmin (1) | activity (4) | running | 482 | **big-endian definitions** (18 of them) |
| `activity_24429547266.tcx` | Garmin export | Activity | "Other" | 1744 trackpoints, **1598 with a position** | skip trackpoints without `<Position>` |
| `activity_24512918380.tcx` | Garmin export | Activity | "Running" | 482 | |

Conclusions:
- **Developer fields and big-endian are both needed** from day one. Compressed timestamps
  didn't occur, but they're cheap to support.
- Altitude checks out: raw 2523 → 2523/5 − 500 = 4.6 m, which is right for the Ghent area.
- **Sport doesn't say gravel.** Wahoo writes cycling/generic, so bike rides get the batch
  activity (default gravel). Running/walking/hiking → hiking.
- **All four samples are recorded activities, none are courses**, so recognising recorded
  rides is the core of this item, not an extra. Course files (planned routes) still need a
  sample: export one from Garmin Connect or Wahoo.
- **Test fixtures are not the raw files.** The repo is public, and recorded rides start and end
  at home. A small tool writes **synthetic** FIT/TCX files with the same structure into
  `web/tests/fixtures/`: Wahoo-style little-endian with developer fields, Garmin-style
  big-endian, and TCX trackpoints without a position. The real files are only used locally,
  to check the decoder against the Python probe.

**Built (2026-09-28):** `fit.js`, `tcx.js`, `trackfile.js`; G1 in the page, the server and
backups. A logged ride keeps no file, only `{date, distance_km, file_hash, note}` in the
route's `rides` (the hash stops the same file being logged twice). Still wanted: a real FIT or
TCX **course** from a device, to check against the synthetic ones.

**Tests:** FIT header/definition/data, both byte orders, compressed timestamps, developer fields,
TCX activity + course, gzip, and the ride-match threshold.

---

## 3. POIs and marks

**What:** points on the map with a category (café/bar, restaurant, water, toilet, bike repair,
train station, sight, photo spot, shelter, other), a name, notes and a link (photo album, website).
- They are shown as a layer on every map, with a filter per category.
- The route panel lists the POIs **along the route** with their km mark, and the elevation
  profile shows them.
- The combiner can route **via a mark** (a via-point for a connector).

**Rik's sources (2026-09-28): Google My Maps maps**, in two export forms. Both were checked on
real files:
- **KMZ** (`Central Antwerp.kmz`, the whole map):
  - a zip holding `doc.kml` + 6 icon PNGs;
  - 144 `<Placemark>`s with `<Point>` only, in **8 `<Folder>`s (the map's layers)**: Hotels,
    Bars, Restaurants, Frituur, Museums / Places to see, Coffee, Transport, and one layer with
    a home address;
  - each placemark has a `<name>` (sometimes CDATA) and a `<styleUrl>` with Google's stock
    icon number (1602 hotel, 1577 restaurant, 1459 train, 1453 parking …); no descriptions.
  - **Design:**
    - the layer (folder) name becomes a **proposed category**, which you can map per layer
      in the import preview (Bars → café/bar, Frituur → *new category "frituur"*,
      Transport → split by icon: 1459 → station);
    - categories are therefore **user-defined**, with a built-in starter set;
    - the map name becomes a POI **list** ("Central Antwerp"), so a list can be shown or
      hidden as a whole;
    - a layer that is one point called like a person/home is offered as *Use as home
      location* and never imported as a POI.
- **CSV** (a single layer, e.g. `Kroegtijgers en Fritleeuwen - Kroegtijgers.csv`, 88 points):
  - header `WKT,name,description`, geometry as `"POINT (lon lat)"` (**lon first**);
  - **gotcha:** `Poppemieke, Café` is written *unquoted* with a comma, so a row has one field
    too many. The parser joins the extra fields back into the name when the header has
    fewer columns;
  - points far away are kept (one is in Romania, one in Amsterdam);
  - the file name after the ` - ` gives the layer, and so the proposed category.
- **Plain CSV** (for lists from elsewhere): `name, lat, lon, category, notes, url` (or
  `lat,lon` in one column, or `WKT`); `;` or `,` separator; decimal commas.

So **KML/KMZ + CSV first**, together with *click on the map*. GPX waypoints next; GeoJSON only
if someone asks.

**How POIs get in:** five ways, cheapest first:
1. **Click on the map → Add mark** (the fastest way to capture "great photo spot here").
2. **GPX waypoints** (`<wpt>`):
   - from standalone waypoint files;
   - from the waypoints already inside your route files: *Import waypoints from this route's
     file*. Today `parseGpx` only reads the link from `<wpt>` (`gpx.js:143`).
   - FIT/TCX course points (item 2).
3. **CSV** with header mapping:
   - columns `name, lat, lon, category, notes, url`; also a single `lat,lon` column and
     Google's `WKT`;
   - `;` as separator and decimal commas (Belgian Excel);
   - a preview before import, and unknown categories go to *other*.
4. **KML/KMZ and GeoJSON:** Google My Maps exports KML/KMZ (a zip, and we have `zip.js`); Google
   Takeout "Saved places" is GeoJSON. This is where most people keep their POI lists.
5. **From OpenStreetMap:** a live overlay (not stored). Click an OSM point → *Keep as my mark* to
   copy it into your own POIs.

**Technical validation**
- **Overpass API (OSM POIs):**
  - CORS works from the page, so it works in the static version too.
  - **But availability is the risk:** in a test today the main instance (`overpass-api.de`)
    answered 504 after 12 s, twice, and the `private.coffee` mirror timed out.
  - Design for that:
    - query only along one route (`around:` over the simplified geometry) or the visible map
      area at zoom ≥ 12;
    - cache results per area in the library for some days;
    - a list of mirrors in `config.js` (setting);
    - fail gently ("OSM points not available right now").
  - In the self-hosted version, the server can proxy and cache (like `/brouter`).
  - Tag mapping:
    - `amenity=drinking_water|toilets|cafe|bar|pub|restaurant|bicycle_repair_station|shelter`;
    - `railway=station`;
    - `tourism=viewpoint|attraction`;
    - `shop=bicycle`.
- **Storage: needs G2.**
  - `kind: "poi"`: id, name, lat, lon, category, list_id, notes, url, source, and `route_ids`
    for explicit links.
  - `kind: "poi_list"`: name, source file, visible.
  - Categories: a settings key (id, label, colour, icon), with a starter set; imports can add
    to it.
  - "Along this route" is computed (within 200 m, configurable), so a POI doesn't have to be
    linked by hand to every route that passes it.
  - Uses the existing grid index / `bboxesNear`.
- **Combiner via-point:** BRouter takes a `lonlats` list, so a via-point is one extra point in the
  connector request (`brouter.js`). The UI is a *via mark…* picker per connector.
- **Export:** POIs in the backup and in *Export set* (the POIs near the set's routes), and as GPX
  waypoints in a downloaded GPX (option).

**Tests:** CSV parsing (separators, decimal comma, header aliases), KML/GeoJSON, `<wpt>` extraction,
the along-route computation with km marks.

---

**Built (2026-09-28):** G2 (the `docs` store: IndexedDB v2, `library_docs` on the
server, `docs` in backups); `poi.js`; KML/KMZ + both CSV forms with the per-layer preview
(checked on Rik's real files: 8 layers of *Central Antwerp*, the 88 *Kroegtijgers*, the
unquoted comma); the Places tab; markers on every map with a popup editor; ＋ Place;
"Places along this route". A built-in **Frituur** category was added.

**Part 2 built (2026-09-28):** waypoints (GPX, FIT/TCX course points) as places; places in
*Export set* / *Add routes from a zip*; a connector through a place in Combine; places from
OpenStreetMap along a route or in the map area (Overpass through `osm.js`: servers in turn,
cache; `/api/overpass` proxy on the server). Measured on the 295 km Diest route: "around" the
route line timed out (26 s), one bounding box answered in 11 s, so the query uses route boxes
and filters locally; bus shelters (`shelter_type=public_transport`, 100 of 175 hits) are left
out.

---

## 4. Catalog

**What:** a browse tree to the left of the library table (hidden on a phone behind a button):
- **Collections:** manual and nestable ("Trips › Ardennes 2026"); a route can be in several.
- **Smart collections:** a saved filter. Filters already live in the URL, so a smart collection
  is a name + a query string.
- **Browse by:** activity, source, tag, **region** (province → municipality of the start),
  loop / point-to-point, and (after item 6) ridden / wishlist.
Clicking a node filters the table and the map, and each node shows a count.
*Export set* and *Show on map* work on a collection.

**Technical validation**
- Collections are documents in G2 (`kind: "collection"`: name, parent_id, route_ids | filter).
- **Own areas** (Rik: yes, 2026-09-28): "Vlaamse Ardennen", "Kempen", "Pajottenland" aren't
  administrative.
  - Draw a polygon on the map (or import one from KML, since My Maps can draw areas too).
  - A route is in the area when its start lies inside it (option: ≥ 50 % of the route).
  - Stored as `kind: "area"` in G2, and shown as a node under *Browse by › Area*.
  - Point-in-polygon is a few lines in `geo.js`.
- **Region needs new data:** our GeoNames tiles hold `[name, code, lat, lon, population, notability,
  order]`, and **no admin regions** (`admin1` is only used at build time for the language).
  Extend `web/tools/build_places.py` with GeoNames `admin1CodesASCII.txt` + `admin2Codes.txt` and
  the admin codes per place.
  - For Belgium, admin1 is the region (Flanders/Wallonia/Brussels) and admin2 the province.
  - The region of a route = the admin of the nearest town to its start, stored on the route
    at import (plus a one-off backfill).
  - To check per country: how deep GeoNames admin levels go for NL/FR/DE.
- Everything else is client-side filtering on data we already have.
- Deleting a route removes it from collections, and restore keeps the links (ids are remapped
  the way *Add routes from a zip* already remaps them).

---

**Built (2026-09-28):** decided with Rik: areas by *start inside*, regions as region ›
province, collections and areas in backups and sets. Part 1: collections (nested), smart
collections, areas (drawn or KML), browse by activity/source/tag/type, a browse tree beside
the library. Part 2: regions: the place tiles rebuilt with province codes and `admin.json`
(Germany as Land › Kreis: the Regierungsbezirk exists in 4 Länder only), each route's start
region stored on import and backfilled at start-up.

---

## 5. Share link + privacy zones

**What:**
- *Share…* in the route panel makes a link to a read-only page on the public site (map, stats,
  elevation profile, surface, notes if you choose). It has *Download GPX* and *Add to my
  library*.
- On a phone it uses the system share sheet (Web Share API).
- A set of routes still goes as an *Export set* zip, because that's too big for a link.

**Technical validation**
- **Nothing is stored on a server.** The route travels in the URL **fragment** (`#r=…`), which
  browsers never send to the server:
  - geometry as an encoded polyline (1e-5 precision) + elevation every ~50 m;
  - compressed with `CompressionStream('deflate-raw')` and base64url.
- **Size estimate:** a 100 km route simplified to ~15–20 m has ~800–1500 points, which is
  ~4–8 KB as a polyline and ~3–5 KB compressed. That's fine for browsers, email, WhatsApp and
  Signal. **To measure on the real library before building**, and to pick the tolerance so
  a 200 km route stays under ~8 KB.
- *Add to my library* writes a GPX from the shared (simplified) track, with source *shared
  link*. It is not the original file, and the page says so.
- **Home location** (setting: map click; stored in settings, never shared). **Privacy zone:** cut
  the shared track where it comes within 500 m (setting) of home, at both ends. This setting is
  also the groundwork for item 7.

---

## 6. Ride log and wishlist

**What:**
- *Ridden…* on a route (date, optional note); the route panel shows its history.
- A ☆ *want to ride* flag.
- Filters: ridden / never ridden / not ridden since …, wishlist.
- Recorded rides from item 2 are logged automatically.
- A small yearly overview: routes ridden, km.

**Technical validation:** route fields only (`rides: [{date, note, file_hash?}]`, `wishlist:
true`). Route documents are schema-free JSON, so there are no server, backup or store changes.
The *Leave out my notes and quality ratings* option for exports should also leave out the ride
log. Small effort.

---

## 7. Train rides

**What:** plan a day with the train, with your library routes as the riding part, in four patterns:

| Pattern | Riding part | Train |
|---|---|---|
| A. Ride out, train back | from home (or near home) → station S | S → home station |
| B. Train out, ride back | station S → home | home station → S |
| C. Train out and back, point to point | station S1 → station S2 | home → S1, S2 → home |
| C′. Train out and back, loop | loop from station S | home ↔ S |

(C′ is probably the most common: a loop near a station.)

**Input:** date, departure time (or "arrive home by"), max transfers (0–3), max km from
route to station (default 3 km), activity (for riding speed, reusing the weather speeds), and a
km range.

**Output:** a ranked list of trips:
- train times and transfers each way;
- riding km, elevation gain and time;
- the total day length (door to door).

Choose one to see it on the map: the route, BRouter connectors home→route and route→station, and
the stations. You can then open it in *Ride weather* (same day and time), or save the riding
part as a new route with the trip in the notes.

**Technical validation**
- **Home location:** from item 5. The home station is the nearest station by default and can be
  changed; a second "also OK" station could come later.
- **Cross-border from the start** (Rik, 2026-09-28: mostly within one country, but Antwerp is
  close to the Dutch border). Tested:
  - **iRail** knows only the 715 SNCB stations, which include a few border stations abroad.
    Antwerp → Roosendaal (37–48 min) and → Breda (34 min, direct) work. Tilburg and
    Bergen op Zoom are "stop not found".
  - **Transitous** plans across the border. Antwerp-Centraal → Breda by rail: EC 9223, 34 min,
    0 transfers. Two gotchas:
    - **Use station stop ids, not coordinates.** With `transitModes=RAIL` and a coordinate a
      few hundred metres from the station, it returns nothing, because it won't add a bus for
      the last bit. Without the RAIL filter it adds buses/coaches (even FlixBus).
    - **Its geocoder mixes feeds:** "Eindhoven Centraal" comes back as a German DELFI id
      (`de-DELFI_000008400206`) and Breda as `nl-OpenOV_stoparea:17911`. So we resolve each
      station's id once (via reverse geocoding on its coordinates, type STOP) and cache it,
      rather than searching by name.
- **Stations:**
  - A bundled static list for BE + NL + LU + northern FR + the German border area, built by
    `web/tools/build_stations.py` from OpenStreetMap (`railway=station`, name, coordinates,
    country). It runs at build time, so Overpass being slow doesn't matter; iRail `/stations`
    can serve as a cross-check for Belgium.
  - The geometric step then needs no network. Stations also show as POIs of category
    *station* (item 3).
- **Two-step search, to stay polite to the free APIs:**
  1. **Offline and instant:** a geometric shortlist.
     - For each route, which stations lie within the max km of its start, end, or (for loops)
       anywhere on it. For loops, the start moves to the point nearest the station; we have
       change-start for this.
     - Which patterns it can fit, and the riding km including connectors (straight-line
       estimate × 1.3).
  2. **Online, on demand:** timetable queries only for the top ~10 of the shortlist (and only
     for station pairs we haven't cached for that day), one request at a time. Then rank by
     total day length or by riding share.
- **Connectors:** home → route start and route end → station go through BRouter with the
  activity's profile, the same code as the combiner.
- **Bikes on trains:** SNCB needs a bike ticket, and some trains/stations are awkward for bikes.
  We can't check that from the API. The result shows a note, and the trip lists the trains so
  you can check.

**To validate before building:**
- iRail's rate limits and fair-use terms;
- whether Transitous is fine with use from a public site (their fair-use page);
- how far ahead the timetables reach.

---

**Built (2026-09-28):** the Train rides utility (four patterns, home station, transfers
filtered here, Transitous with iRail as fallback, stations from OpenStreetMap via
`build_stations.py`: 2,370 stations, 1,886 with a UIC code). Findings: Belgian stations get
their Transitous id from the UIC code (`be-sncb_S<uic>`); others are looked up by name and the
nearest result kept (ids differ per feed: `nl-OpenOV_stoparea:…`, `de-DELFI_…`,
`be-sncb_<uic>`). Transitous answers 403 to Node's default fetch (not to browsers). Stations
within 10 km of the home station don't count, and each pattern gets its turn among the trips
that are timed (otherwise loops next to a station took every place).

---

## Answered (2026-09-28)

1. FIT/TCX samples: two FIT and two TCX files, all recorded activities (see item 2). A **course**
   file is still wanted.
2. POIs: Google My Maps, as KMZ and CSV (see item 3). KML/KMZ + CSV import first.
3. Trains: cross-border from the start (see item 7).
4. Catalog: yes to own areas such as Vlaamse Ardennen (see item 4).

## Still open

- A FIT or TCX **course** (a planned route) as a test file.
- Transitous fair-use terms for a public site, iRail rate limits, how far ahead timetables reach.
