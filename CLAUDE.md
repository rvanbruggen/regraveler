# rerouter - project brief

A web app (formerly "regraveler") to manage a personal library of routes (GPX files) for gravel cycling, road cycling and hiking: store them with structured metadata, show them on a map, and combine two routes into a new one using an automatically routed connector.

## Architecture (since the js-core branch)

One codebase for the route logic: the page in `web/` (vanilla JS ES modules + Leaflet) does everything — GPX parsing, stats, names, combining, similarity, surface estimate. It runs two ways:

- **Self-hosted** (`docker compose up`): the thin Python server in `app/` serves `web/`, stores the library (SQLite route documents + the GPX folder) through a small storage API, proxies `/brouter` to the BRouter container, and fetches GPX files from public links for "Import from a link" (`/api/fetch-gpx`, public internet addresses only). It computes nothing.
- **Static site** (GitHub Pages): the same page keeps the library in IndexedDB and uses the public BRouter at brouter.de (it allows CORS).

The page picks its storage at start-up (`GET api/info` answers → server). Both share one backup format (`library.json` + `gpx/<sha256>.gpx`). Route logic changes go in `web/js/`; the server only changes when the storage contract does. Up to 0.7.x the logic was in Python; `app/legacy.py` moves an old library to the new store.

## Context

- Owner: Rik (Antwerp, Belgium). Routes are mainly in Flanders / Belgium.
- Scale: hundreds of routes to start. No need to design for thousands yet.
- Deployment: Docker (docker compose) on Rik's own home server, and the browser-only version on GitHub Pages. Possibly hosted publicly later, so keep that door open but don't build for it now (no user accounts, no multi-tenancy).
- Existing data: a folder of GPX files (downloaded from gravelroutedatabase.be, renamed to the route name). The files contain `<ele>` elevation tags, so elevation gain can be computed from the files directly.
- Language preference: Python over Node.js for servers and tools. The route logic is JavaScript because it has to run in the browser (decided 2026-09-27: one codebase instead of a Python and a JS copy).

## Stack

| Layer | Choice |
|---|---|
| Route logic + UI | `web/`: single page, vanilla JS (ES modules, no build step, no npm dependencies) + Leaflet, OpenStreetMap tiles |
| Geometry | Own code in `web/js/geo.js` (EPSG:3035 LAEA projection, Vincenty distance, grid index, exact buffer intersections) |
| Browser storage | IndexedDB (`web/js/db.js`) |
| Server | Python 3.12, FastAPI, SQLAlchemy + SQLite (route documents as JSON), `app/` |
| Routing | BRouter, self-hosted as a separate container (proxied at `/brouter`), or the public brouter.de for the static version |
| Weather | Open-Meteo forecast API (free, no key, CORS), called from the page (`web/js/weather.js`) |
| Place names | GeoNames tiles in `web/data/places/`, built by `web/tools/build_places.py` |
| Tests | Node's built-in test runner for `web/js` (`cd web && npm test`); pytest for the server |
| Deployment | docker-compose.yml with `app` and `brouter` services; volumes for `data/` (db) and `gpx/` (files). GitHub Pages workflow for `web/` |

Keep dependencies minimal. Verify BRouter's current Docker setup, data tile download and profile options from its official repository before implementing phase 3 - don't assume.

## Data model (starting point)

**Route**
- id, name, slug
- gpx_path (original file stored on disk, never modified)
- Computed on import: distance_km, elevation_gain_m, elevation_loss_m, min/max elevation, start point, end point, bounding box, is_loop (start and end within ~200 m), simplified geometry for map display
- User metadata: quality_rating (1-5), paved_pct (manual for now), tags (free text list), notes
- Provenance: source_name, source_url, imported_at
- Derivation: derived_from (list of parent route ids) for combined routes
- file_hash (for duplicate detection)

Keep metadata fields easy to extend (e.g. surface type, difficulty, best season).

## Phases

### Phase 1 - Import and library
- Bulk upload of GPX files (drag and drop, multiple files at once).
- Set source name + source URL for the whole batch, with per-file override.
- Compute stats on import (see data model). Smooth elevation before computing gain so GPS noise doesn't inflate the numbers.
- Duplicate check on file hash; warn on routes with very similar geometry.
- Library view: table with sorting and filters (distance, elevation gain, paved %, quality, tags, source).
- Edit metadata per route.
- Download original GPX.
- A CLI/import script to load the existing GPX folder in one go.

### Phase 2 - Map
- All (filtered) routes on one Leaflet map as coloured lines; click a route for details.
- Filters shared with the library view.
- Highlight routes that overlap or come within a configurable distance of each other (bounding-box prefilter, then geometric check).

### Phase 3 - Combiner (automatic gap-filling)
Flow:
1. User selects two routes (A and B) on the map.
2. App shows where they come closest and pre-suggests the closest pair of points.
3. User confirms or moves a connection point on each route.
4. App asks BRouter for a gravel-friendly connector between the two points.
5. App stitches: route A up to its connection point -> connector -> route B from its connection point.
6. Preview on map with stats (total distance, elevation, connector length).
7. Save as a new route with derived_from = [A, B], and export as GPX.

Design requirement: support one OR two connection pairs. A single pair gives a point-to-point combination; two pairs let the user build a loop (A -> connector 1 -> B -> connector 2 -> back to A). Handle route direction (allow reversing a route or segment).

### Phase 4 - Nice-to-haves
- Estimate paved_pct automatically by matching the route against OpenStreetMap `surface` tags; user can override.
- Better duplicate/near-duplicate detection.
- Export selections of routes (zip).

## Working agreements

- Build phase by phase; each phase should be usable on its own and runnable with `docker compose up`.
- Include a README with setup, run and import instructions.
- Write tests for the GPX stats and stitching logic (these are where bugs will hide) — in `web/tests/` (Node).
- Never modify original GPX files; derived routes are new files.
- Ask before adding significant new dependencies or changing the stack.
- Keep the UI simple and functional; clarity over polish.
- Releases go through the `/bump` skill (major / minor / dot). The version source of truth is `__version__` in `app/__init__.py`; `web/js/config.js` (`VERSION`) and `web/package.json` must match. See "Version Tracking" in the README for every place it appears. Each release is committed, tagged `v<version>` and pushed.
