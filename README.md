# regraveler — Gravel Route Manager

A self-hosted web app to manage a personal library of gravel cycling routes (GPX files):
import them, compute stats, tag and rate them, and (in later phases) show them on a map and
combine routes with an automatically routed connector.

**Version:** 0.2.1 · **Status: phase 2 (import, library, map).** See [CLAUDE.md](CLAUDE.md) for
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
  - **Duplicates:** an identical file (same SHA-256) is skipped. Routes with very similar
    geometry (≥ 80 % of each route within 50 m of the other) are imported but flagged.
- **Library:** sortable table with filters on distance, elevation gain, paved %, quality,
  tags, source, loop/point-to-point and a text search. Filters are kept in the URL.
- **Route details:** map, stats, edit metadata (name, quality 1–5, paved %, tags, notes,
  source), list of similar/overlapping routes, download of the original GPX, remove from library.

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

Original GPX files are never modified.

## Run with Docker

```bash
docker compose up -d --build
```

Open http://localhost:8082 (or `http://<server>:8082`).

Volumes (bind mounts next to `docker-compose.yml`):

| Host folder | In container | Contents |
|---|---|---|
| `./data` | `/data` | `routes.db` (SQLite) |
| `./gpx` | `/gpx` | The GPX library. Uploaded files are stored in `gpx/uploads/<source>/`. |

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

Settings (environment variables): `LOOP_THRESHOLD_M` (200), `SIMILAR_TOLERANCE_M` (50),
`SIMILAR_MIN_OVERLAP` (0.8), `PROXIMITY_DISTANCE_M` (100, default distance on the map),
`PROXIMITY_MAX_DISTANCE_M` (5000).

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
  models.py      SQLAlchemy model
  db.py          database setup and automatic column migration
  main.py        FastAPI app (JSON API + static frontend)
  cli.py         command line import / recompute
  static/        single-page frontend (vanilla JS + Leaflet)
tests/           pytest tests
```

## Version Tracking

Versions follow `a.b.c` (major / minor / dot) and every release is tagged `v<a.b.c>`.
The version appears in these places, which must stay in sync:

- `app/__init__.py` — `__version__` (source of truth; served at `/api/version`, shown in the UI header)
- `README.md` — the **Version:** line at the top
- `CHANGELOG.md` — one row per release
