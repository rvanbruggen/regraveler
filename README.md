# regraveler — Gravel Route Manager

A self-hosted web app to manage a personal library of gravel cycling routes (GPX files):
import them, compute stats, tag and rate them, and (in later phases) show them on a map and
combine routes with an automatically routed connector.

**Status: phase 1 (import + library).** See [CLAUDE.md](CLAUDE.md) for the full plan.

## What it does (phase 1)

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

Original GPX files are never modified.

## Run with Docker

```bash
docker compose up -d --build
```

Open http://localhost:8000 (or `http://<server>:8000`).

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

Settings (environment variables): `LOOP_THRESHOLD_M` (200), `SIMILAR_TOLERANCE_M` (50),
`SIMILAR_MIN_OVERLAP` (0.8).

## Adding metadata fields

Add a nullable column to `Route` in `app/models.py`; it is added to an existing database
automatically on the next start. Then expose it in `RouteSummary`/`RouteUpdate` in
`app/main.py` and in the edit form (`app/static/index.html`, `app/static/app.js`).

## Project layout

```
app/
  gpxstats.py    GPX parsing and statistics (pure functions)
  similarity.py  geometric overlap / near-duplicate detection
  importer.py    import of files and folders
  models.py      SQLAlchemy model
  db.py          database setup and automatic column migration
  main.py        FastAPI app (JSON API + static frontend)
  cli.py         command line import / recompute
  static/        single-page frontend (vanilla JS + Leaflet)
tests/           pytest tests
```
