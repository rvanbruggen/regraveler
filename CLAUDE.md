# Gravel Route Manager - project brief

A self-hosted web app to manage a personal library of gravel cycling routes (GPX files): store them with structured metadata, show them on a map, and combine two routes into a new one using an automatically routed connector.

## Context

- Owner: Rik (Antwerp, Belgium). Routes are mainly in Flanders / Belgium.
- Scale: hundreds of routes to start. No need to design for thousands yet.
- Deployment: Docker (docker compose) on Rik's own home server. Possibly hosted publicly later, so keep that door open but don't build for it now (no user accounts, no multi-tenancy).
- Existing data: a folder of GPX files (downloaded from gravelroutedatabase.be, renamed to the route name). The files contain `<ele>` elevation tags, so elevation gain can be computed from the files directly.
- Language preference: Python over Node.js.

## Stack

| Layer | Choice |
|---|---|
| Backend | Python 3.12, FastAPI |
| GPX parsing | gpxpy |
| Geometry | Shapely (+ pyproj for metric distances) |
| Database | SQLite (via SQLAlchemy), single file on a Docker volume |
| Frontend | Single-page HTML + vanilla JS + Leaflet, OpenStreetMap tiles. No heavy framework. |
| Routing (phase 3) | BRouter, self-hosted as a separate container, with routing data tiles for Belgium and neighbouring areas |
| Deployment | docker-compose.yml with `app` and `brouter` services; volumes for `data/` (db) and `gpx/` (files) |

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
- Write tests for the GPX stats and stitching logic (these are where bugs will hide).
- Never modify original GPX files; derived routes are new files.
- Ask before adding significant new dependencies or changing the stack.
- Keep the UI simple and functional; clarity over polish.
