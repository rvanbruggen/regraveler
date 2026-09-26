# Changelog

| Version | Date | Changes |
|---|---|---|
| **0.3.1** | 2026-09-26 | Library: select several routes (checkboxes, select all shown) to download their GPX files (zip for several), show only them on the map, or remove them in one go |
| **0.3.0** | 2026-09-26 | Phase 3: combiner. Pick two routes, get suggested connection points, drag them along the routes, gravel connectors routed by a self-hosted BRouter (v1.7.10, profile choice, prefer unpaved, straight-line fallback), one connection (A → B) or two (loop), direction options, preview with stats, save as a new derived route or download GPX. Docker: `brouter` and `brouter-segments` services with automatic tile download. Fix: hidden filter bar on Import, phone layout of the header and maps |
| **0.2.1** | 2026-09-26 | Docker: app published on host port 8082 instead of 8000 |
| **0.2.0** | 2026-09-26 | Phase 2: map of all filtered routes (shared filters with the library, click for details, "Show on map"), highlighting of routes that overlap or come within a configurable distance (STRtree prefilter, shared stretches, closest points, pair list), gzip responses |
| **0.1.0** | 2026-09-26 | Phase 1: GPX import (drag and drop + folder CLI), stats with smoothed elevation, duplicate and near-duplicate detection, library table with filters and sorting, route detail panel with map and metadata editing, GPX download, Docker setup |
