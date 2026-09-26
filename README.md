<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/logo-wordmark-dark.svg">
  <img alt="regraveler" src="docs/logo-wordmark-light.svg" width="360">
</picture>

# regraveler — Gravel Route Manager

A self-hosted web app to manage a personal library of gravel cycling routes (GPX files):
import them, compute stats, tag and rate them, show them on a map, and combine two routes into
a new one with automatically routed gravel connectors (via a self-hosted BRouter).

**Version:** 0.5.1 · **Status: phase 4 (import, library, map, combiner, surface estimate, duplicates).** See [CLAUDE.md](CLAUDE.md) for
the full plan and [CHANGELOG.md](CHANGELOG.md) for the version history.

## What it does

- **Import** GPX files by drag and drop (many at once) or with a CLI script for a whole folder.
  - Source name and URL per batch, with per-file override. If no URL is given, the link inside
    the GPX file (if any) is used.
  - Computed on import: distance, elevation gain/loss (smoothed, see below), min/max elevation,
    start/end point, bounding box, loop detection (start and end within 200 m) and a
    simplified geometry for maps.
  - A GPX file with several tracks (e.g. `Start Bertem.gpx`, which holds 5 routes) becomes one
    route per track.
  - **Duplicates:** an identical file (same SHA-256) is skipped, and so is the same track in a
    different file (same coordinates, but e.g. another name, encoding or creator). Routes with
    very similar geometry (≥ 85 % of each route within 50 m of the other) are imported but
    flagged.
  - **Surface:** after an upload, the paved % of the new routes is estimated in the background
    from OpenStreetMap (see below).
  - **Name:** new routes are named after the places they visit (see *Route names*); the name
    from the file is kept at the top of the notes (`Original name: …`).
- **Library:** sortable table with filters on distance, elevation gain, paved %, quality,
  tags, source, loop/point-to-point and a text search. Filters are kept in the URL.
- **Select several routes** with the checkboxes in the library (the header box selects all
  shown routes), then:
  - **Download GPX:** one route downloads its original file; several download as `routes.zip`
    with the original files (a multi-track file is included once).
  - **Show on map:** the map (and library) show only the selected routes until you click
    *show all routes* or *Clear*.
  - **Estimate surface:** (re)estimates the paved % from OpenStreetMap; progress is shown next
    to the route count.
  - **Remove:** removes them from the library after one confirmation (GPX files stay on disk).
- **Route details:** map, stats, edit metadata (name, quality 1–5, paved %, tags, notes,
  source), list of similar/overlapping routes, download of the original GPX, remove from library.
- **Surface from OpenStreetMap:** each route's surface is estimated as *paved*, *cobbles*
  (sett/cobblestones, counted as paved), *unpaved* and *unknown*. The route panel shows the
  breakdown as a bar, colours the map by surface, and has *Estimate again*. The paved % in the
  library comes from the estimate (shown as ≈38%) unless you type your own value, which then
  always wins; the panel offers *use the estimate* to switch back, and clearing the field does
  the same. Needs BRouter (see Docker); routes outside the downloaded tiles can't be estimated.
- **Route names:** *suggest names…* above the library (or *Rename…* for selected routes) opens
  a review screen with a proposed name per route: the start town, then up to three places the
  route visits, in riding order, e.g. *Tervuren – Kapucijnenbos – Duisburg – Hogenbos* (for a
  point-to-point route the last place is where it ends). Edit proposals, untick routes to leave
  alone, and rename; the current name is kept at the top of the notes (only the first time).
  Routes with the same proposal get the distance added.
- **Duplicates tab:** all groups of near-duplicate routes in the library (e.g. the same route
  downloaded from two sites), with overlap, source, rating and tags per route, "identical
  track" and "ridden the other way" hints, and a suggestion which one to keep (the one with the
  most of your own ratings, tags and notes, then the oldest). *Remove ticked*, *Show on map*, or
  *Not duplicates* (hides the group). Below that, **variants**: routes that lie (almost)
  entirely on a longer route, such as a short loop inside a long one.

- **Map:** all routes that match the filters (the same filter bar as the library) drawn as
  coloured lines on an OpenStreetMap map. Hover for the name, click a route to open its details
  (the side list then shows only the routes near it). "Show on map" in the route panel jumps there.
- **Routes near each other:** tick *Highlight routes near each other* and set a distance
  (default 100 m). Routes that overlap or come within that distance of another route stay
  coloured, the rest fade out. Shared stretches are drawn in yellow, and for near misses a
  dashed line marks the closest points. The side list shows every pair (shared km, % of each
  route, or the gap in metres); click a pair to zoom to it.
- The filters, the active view and the proximity setting are kept in the URL, so a bookmark
  brings back the same screen.
- **Combine** two routes into a new one by picking the part of each route you want to ride:
  1. Pick route A and B (dropdowns, click them on the Combine map, "Combine…" in a route's
     detail panel, or "combine" next to a pair in the map's proximity list).
  2. The app suggests four points where the routes come closest: you ride route A from A1 to
     A2 and route B from B1 to B2.
  3. Change them with *Click all four* (click A1, A2, B1, B2 on the map in turn; Esc cancels),
     *Place* next to a single point, or drag a point along its route. Clicks snap onto the
     route. *Suggest* puts the suggested points back.
  4. The gaps are filled with connectors routed by BRouter (profile *gravel* by default,
     optionally *prefer unpaved paths*; other profiles or plain straight lines are possible).
     Points less than 25 m apart are joined directly.
  5. Preview with total distance, elevation gain, the km on each route and connector lengths.
  6. Save as a new route (a new GPX file in `gpx/derived/`, source *combined*, with the parent
     routes recorded and linked in its detail panel), or just download the GPX.
  - **Loop:** A1 → A2 → connector → B1 → B2 → connector back to A1. The loop starts at A1.
  - **Point to point:** A1 → A2 → connector → B1 → B2.
  - The riding direction on a route follows the order of its two points: *Swap A1 ↔ A2* (or
    B1 ↔ B2) rides it the other way. When the connectors of a loop cross each other, the app
    says so; swapping B1 and B2 usually fixes it. For loop routes, *Other way round A/B* takes
    the other part of that loop (through its start). *Ride the whole result the other way*
    reverses the direction.

Original GPX files are never modified.

## Run with Docker

```bash
docker compose up -d --build
```

Open http://localhost:8082 (or `http://<server>:8082`).

The first start downloads BRouter's routing data for Belgium and its surroundings
(~640 MB, see [BRouter routing data](#brouter-routing-data)) and builds BRouter from source, so
it takes a few minutes. Later starts are quick.

Volumes (bind mounts next to `docker-compose.yml`):

| Host folder | In container | Contents |
|---|---|---|
| `./data` | `/data` | `routes.db` (SQLite) |
| `./gpx` | `/gpx` | The GPX library. Uploaded files are stored in `gpx/uploads/<source>/`, combined routes in `gpx/derived/`. |
| `./brouter/segments4` | `/segments4` (brouter) | BRouter routing data tiles (`.rd5`) |

Services: `app` (this app), `brouter` (routing engine, built from the official
[abrensch/brouter](https://github.com/abrensch/brouter) v1.7.10 source; only reachable by the
app, not published on the host) and `brouter-segments` (one-off job that downloads missing
routing data before BRouter starts).

### BRouter routing data

BRouter needs routing data tiles from [brouter.de/brouter/segments4](https://brouter.de/brouter/segments4/):
5×5 degree files named after their south-west corner. The default set covers Belgium and the
neighbouring areas:

| Tile | Covers | Size (approx.) |
|---|---|---|
| `E0_N50` | 0–5° E, 50–55° N: Flanders, Brussels, west of the Netherlands | 80 MB |
| `E5_N50` | 5–10° E, 50–55° N: Limburg, east of the Netherlands, western Germany | 180 MB |
| `E0_N45` | 0–5° E, 45–50° N: south of Wallonia, northern France | 130 MB |
| `E5_N45` | 5–10° E, 45–50° N: Luxembourg, the Ardennes south of 50° N | 250 MB |

To use other tiles, set `BROUTER_TILES` (space separated) in a `.env` file next to
`docker-compose.yml`, e.g. `BROUTER_TILES=E0_N50 E5_N50`, and run `docker compose up -d`.
If a connector falls outside the downloaded tiles, the combiner says which tile is missing.

The tiles are rebuilt weekly from OpenStreetMap. To refresh them (only changed tiles are
downloaded), then restart BRouter:

```bash
docker compose run --rm brouter-segments update
```

```bash
docker compose restart brouter
```

### Import an existing folder of GPX files

Put the files somewhere under `./gpx` (subfolders are fine; the subfolder name becomes the
source name), then:

```bash
docker compose run --rm app python -m app.cli import /gpx
```

Files already inside the library folder are referenced in place, not copied. Running the
import again is safe: files that are already imported are skipped.

Options:

- `--source-name NAME` — source name for all files (instead of the subfolder name)
- `--source-url URL` — source URL for all files
- `--no-source-from-folder` — don't use the subfolder name as source name

A folder outside `./gpx` can also be imported; its files are copied into `gpx/uploads/`.

After changing the stats algorithm, recompute all routes from their GPX files:

```bash
docker compose run --rm app python -m app.cli recompute
```

Estimate the surface of all routes that don't have an estimate yet (e.g. after upgrading to
0.4.0; add `--all` to redo every route, `--overwrite-manual` to also replace paved % values you
typed yourself):

```bash
docker compose run --rm app python -m app.cli estimate-surface
```

## Run locally (development)

Python 3.12:

```bash
python3.12 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m app.cli import gpx
.venv/bin/uvicorn app.main:app --reload
```

The app then runs at http://localhost:8000 with the database in `./data` and the library in
`./gpx`. Override with the `DATA_DIR` and `GPX_DIR` environment variables.

The combiner needs a BRouter server at `BROUTER_URL` (default `http://localhost:17777`). Without
Docker: download a release zip from [BRouter's releases](https://github.com/abrensch/brouter/releases)
(needs Java 17+) and one or more tiles, then run from the unpacked folder:

```bash
java -Xmx128M -cp brouter-1.7.10-all.jar btools.server.RouteServer segments4 profiles2 customprofiles 17777 1
```

Without BRouter, the combiner still works with *Straight lines (no routing)*.

Run the tests:

```bash
.venv/bin/python -m pytest
```

## How the stats are computed

- **Distance:** geodesic (WGS84) distance between consecutive points.
- **Elevation:** the elevation profile is resampled every 10 m along the route, smoothed with a
  50 m moving average, and then ascent/descent is summed with a 1 m hysteresis (small
  up/down wiggles are ignored). Missing `<ele>` values are interpolated. These settings were
  calibrated against the `77km-430hm`-style values in the gravelroutedatabase.be track names
  (median within ~5 %). Note that different sources use different elevation data, so the same
  route can show a different gain depending on where the file came from.
- **Similarity:** routes are projected to a metric CRS (EPSG:3035, Europe) and compared with a
  bounding-box prefilter, then the share of each route's length lying within 50 m of the other.

- **Routes near each other (map):** a spatial index (STRtree) on the projected routes does the
  bounding-box prefilter, then the exact line-to-line distance is checked. For each pair the
  shared stretches are each route's parts within the chosen distance of the other.

- **Combiner:** the parts of A and B are cut from the full-resolution points of the original GPX
  files (not the simplified map lines), with interpolated points exactly at the chosen
  points. The stitching works on a list of parts (route + start + end point), so combining more
  than two routes is a matter of UI; the API (`POST /api/combine/preview` with `parts`) already
  accepts up to six. Suggestions come from a distance matrix of points sampled every 50 m along both
  routes; the second connection of a loop is the closest pair that is at least 2 km (or 15 % of
  the shorter route) away from the first along both routes. The stats of the result are
  computed the same way as for imported routes. Connector elevations come from BRouter (SRTM),
  so there can be small elevation jumps where they join the original tracks.

- **Surface estimate:** the GPX track is "map matched" with BRouter: a route is requested
  through waypoints every 300 m along the track with the `shortest` profile, so BRouter follows
  the track itself (the matched length is typically within 1 % of the route length), and with
  `processUnusedTags=1` BRouter reports every OpenStreetMap tag of each way it used. Each
  stretch is classified by its `surface` tag; without one, the road type decides (a residential
  street or cycleway is paved, a `grade1` track paved, other tracks and paths unpaved; the panel
  says how many km were guessed this way). paved % = (paved + cobbles) / (paved + cobbles +
  unpaved), and is left empty when more than half of the route is unknown.
- **Route names:** place data comes from [GeoNames](https://www.geonames.org/) (CC BY 4.0):
  the country files for `GEONAMES_COUNTRIES` (default `BE,NL,LU,DE,FR`: about 26 MB to download,
  95 MB on disk) are downloaded
  on first use into `data/geonames/`. Towns and villages are ranked by population (villages
  without one only count if they're widely known); landmarks are named forests, heaths, hills,
  parks, lakes, castles and abbeys the route passes close to. Names are in `PLACE_NAME_LANGUAGE`
  (Dutch by default: Zoniënwoud rather than Forêt de Soignes). The start is the nearest real
  town to the start point; the places are the most notable one in each third of the route.
  To save space, list only the countries you ride in, e.g. `GEONAMES_COUNTRIES=BE,NL`.
- **Duplicates:** a hash of each track's coordinates (rounded to ~1 m) finds the same track in
  different files. The Duplicates tab compares all routes with a spatial index and groups routes
  where ≥ 85 % of each lies within 50 m of the other; a route with ≥ 90 % on another is listed
  as a variant. "Ridden the other way" compares positions along both routes.

Settings (environment variables): `LOOP_THRESHOLD_M` (200), `SIMILAR_TOLERANCE_M` (50),
`SIMILAR_MIN_OVERLAP` (0.85), `VARIANT_MIN_OVERLAP` (0.9), `PROXIMITY_DISTANCE_M` (100, default distance on the map),
`PROXIMITY_MAX_DISTANCE_M` (5000), `BROUTER_URL` (`http://localhost:17777`; set to
`http://brouter:17777` in docker-compose), `BROUTER_PROFILES` (`gravel,trekking,mtb,fastbike,shortest`;
the first is the default), `BROUTER_TIMEOUT_S` (60), `DIRECT_JOIN_M` (25),
`SURFACE_MATCH_PROFILE` (`shortest`), `SURFACE_WAYPOINT_SPACING_M` (300), `SURFACE_AUTO_ESTIMATE`
(1; 0 to only estimate on request), `GEONAMES_COUNTRIES` (`BE,NL,LU,DE,FR`), `PLACE_NAME_LANGUAGE`
(`nl`), `AUTO_RENAME_ON_IMPORT` (1; 0 keeps the names from the files).

## Adding metadata fields

Add a nullable column to `Route` in `app/models.py`; it is added to an existing database
automatically on the next start. Then expose it in `RouteSummary`/`RouteUpdate` in
`app/main.py` and in the edit form (`app/static/index.html`, `app/static/app.js`).

## Project layout

```
app/
  gpxstats.py    GPX parsing and statistics (pure functions)
  similarity.py  geometric overlap: near-duplicates, routes near each other
  importer.py    import of files and folders
  combiner.py    cutting, direction handling and stitching of combined routes
  brouter.py     client for the BRouter HTTP API
  surface.py     surface estimate (map matching via BRouter) and its background worker
  places.py      route names from GeoNames places (start town + places visited)
  models.py      SQLAlchemy model
  db.py          database setup and automatic column migration
  main.py        FastAPI app (JSON API + static frontend)
  cli.py         command line import / recompute
  static/        single-page frontend (vanilla JS + Leaflet)
brouter/
  download-segments.sh  downloads BRouter routing data tiles (used by docker-compose)
tests/           pytest tests
```

## Version Tracking

Versions follow `a.b.c` (major / minor / dot) and every release is tagged `v<a.b.c>`.
The version appears in these places, which must stay in sync:

- `app/__init__.py` — `__version__` (source of truth; served at `/api/version`, shown in the UI header)
- `README.md` — the **Version:** line at the top
- `CHANGELOG.md` — one row per release
