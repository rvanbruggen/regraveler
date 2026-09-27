// Estimate the surface (paved %) of a route from OpenStreetMap data (port of surface.py).
//
// The route is "map matched" with BRouter: we route through waypoints taken every
// SURFACE_WAYPOINT_SPACING_M metres along the GPX track, with the `shortest` profile, so
// BRouter follows the track itself. With processUnusedTags=1 BRouter reports all OSM tags of
// every way it used, per segment, which gives the surface along the route.
//
// Categories: paved, cobbles (sett/cobblestone: paved, but worth knowing), unpaved, unknown.
// When a way has no `surface` tag, its type decides (a residential street is paved, a grade 3
// track is not); that share is reported as "inferred".

import * as brouter from "./brouter.js";
import { latLonOf, pointAt } from "./combiner.js";
import { config, publicBRouter } from "./config.js";
import { geodesicDistance, round, simplifyLatLon } from "./geo.js";

const PAVED = new Set([
  "paved", "asphalt", "chipseal", "concrete", "concrete:lanes", "concrete:plates",
  "paving_stones", "paving_stones:lanes", "bricks", "brick", "metal", "metal_grid",
  "wood", "rubber", "tartan", "acrylic",
]);
const COBBLES = new Set(["sett", "cobblestone", "unhewn_cobblestone", "cobblestone:flattened"]);
const UNPAVED = new Set([
  "unpaved", "compacted", "fine_gravel", "gravel", "shells", "rock", "pebblestone", "ground",
  "dirt", "earth", "grass", "grass_paver", "mud", "sand", "woodchips", "snow", "ice", "salt",
  "soil", "clay",
]);
// Roads that are paved unless tagged otherwise.
const PAVED_HIGHWAYS = new Set([
  "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
  "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified", "residential",
  "living_street", "service", "pedestrian", "cycleway", "busway", "road",
]);
const UNPAVED_HIGHWAYS = new Set(["path", "bridleway"]);

export const CATEGORIES = ["paved", "cobbles", "unpaved", "unknown"];

/** [category, inferred] for a way's OSM tags. */
export function classify(tags) {
  const surface = (tags.surface || "").split(";")[0].trim();
  if (PAVED.has(surface)) return ["paved", false];
  if (COBBLES.has(surface)) return ["cobbles", false];
  if (UNPAVED.has(surface)) return ["unpaved", false];
  const highway = tags.highway || "";
  if (highway === "track") return [tags.tracktype === "grade1" ? "paved" : "unpaved", true];
  if (PAVED_HIGHWAYS.has(highway)) return ["paved", true];
  if (UNPAVED_HIGHWAYS.has(highway)) return ["unpaved", true];
  return ["unknown", true];
}

/** Default matcher: BRouter with all OSM tags. waypoints -> {length, rows, coords}. */
export const brouterMatcher = (waypoints) =>
  brouter.wayTags(waypoints, config.SURFACE_MATCH_PROFILE, { processUnusedTags: "1" });

export function matchWaypoints(track, spacingM) {
  const ds = [];
  for (let d = 0; d < track.length; d += spacingM) ds.push(d);
  ds.push(track.length);
  return ds.map((d) => latLonOf(pointAt(track, d)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Surface breakdown of a route (km per category) and the resulting paved %.
 * matcher: async (waypoints) -> {length, rows: [[distance_m, tags], ...], coords}
 */
export async function estimate(track, { matcher = brouterMatcher, spacingM = null, chunk = 60, pauseMs = null, onProgress = null } = {}) {
  const spacing = spacingM || config.SURFACE_WAYPOINT_SPACING_M;
  const pause = pauseMs ?? (matcher === brouterMatcher && publicBRouter() ? config.SURFACE_REQUEST_PAUSE_MS : 0);
  const waypoints = matchWaypoints(track, spacing);
  const km = { paved: 0, cobbles: 0, unpaved: 0, unknown: 0 };
  let inferred = 0, matched = 0;
  const surfaces = new Map();
  const segments = []; // [[category, [[lat, lon], ...]], ...] for colouring the map
  // Requests with a limited number of waypoints; consecutive chunks share an end point.
  const starts = [];
  for (let i = 0; i < waypoints.length - 1; i += chunk - 1) starts.push(i);
  for (let n = 0; n < starts.length; n++) {
    const part = waypoints.slice(starts[n], starts[n] + chunk);
    if (part.length < 2) break;
    if (n && pause) await sleep(pause);
    onProgress?.(n, starts.length);
    const { length, rows, coords } = await matcher(part);
    matched += length;
    const cats = [];
    for (const [dist, tags] of rows) {
      const [cat, wasInferred] = classify(tags);
      cats.push([dist, cat]);
      km[cat] += dist;
      if (wasInferred) inferred += dist;
      const name = tags.surface || `(${tags.highway || "unknown"})`;
      surfaces.set(name, (surfaces.get(name) || 0) + dist);
    }
    addSegments(segments, coords, cats);
  }
  // Display only: simplify each run to keep the stored estimate small.
  const simple = segments.map(([cat, line]) => [cat, simplifyLatLon(line, 4)]);

  const total = Object.values(km).reduce((a, b) => a + b, 0) || matched;
  const known = km.paved + km.cobbles + km.unpaved;
  const pavedPct = known && known >= 0.5 * total ? Math.round((100 * (km.paved + km.cobbles)) / known) : null;
  const top = [...surfaces].sort((a, b) => b[1] - a[1]).slice(0, 8);
  return {
    ...Object.fromEntries(CATEGORIES.map((c) => [`${c}_km`, round(km[c] / 1000, 2)])),
    inferred_km: round(inferred / 1000, 2),
    matched_km: round(matched / 1000, 2),
    route_km: round(track.length / 1000, 2),
    match_ratio: track.length ? round(matched / track.length, 3) : null,
    paved_pct: pavedPct,
    top_surfaces: top.map(([name, m]) => [name, round(m / 1000, 2)]),
    segments: simple,
    estimated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  };
}

/**
 * Split the routed geometry into runs of one surface category. BRouter's message rows give
 * the length of each stretch in order; walk along the geometry by distance and give every
 * point the category of the stretch it is in.
 */
export function addSegments(segments, coords, cats) {
  if (coords.length < 2 || !cats.length) return;
  const along = [0];
  for (let k = 1; k < coords.length; k++) {
    along.push(along[k - 1] + geodesicDistance(coords[k - 1][0], coords[k - 1][1], coords[k][0], coords[k][1]));
  }
  let bounds = [];
  let s = 0;
  for (const [d] of cats) bounds.push((s += d));
  // Scale: the message distances and our geometry lengths differ slightly.
  const last = bounds[bounds.length - 1];
  if (last > 0) bounds = bounds.map((b) => (b * along[along.length - 1]) / last);
  const r5 = (c) => [round(c[0], 5), round(c[1], 5)];
  for (let k = 1; k < coords.length; k++) {
    // searchsorted(bounds, along - 1e-9, side="left"): first bound >= value
    const v = along[k] - 1e-9;
    let idx = bounds.findIndex((b) => b >= v);
    if (idx < 0) idx = cats.length - 1;
    const cat = cats[Math.min(idx, cats.length - 1)][1];
    const prev = r5(coords[k - 1]), point = r5(coords[k]);
    const lastSeg = segments[segments.length - 1];
    if (lastSeg && lastSeg[0] === cat && sameXY(lastSeg[1][lastSeg[1].length - 1], prev)) lastSeg[1].push(point);
    else segments.push([cat, [prev, point]]);
  }
}

const sameXY = (p, q) => p[0] === q[0] && p[1] === q[1];

/**
 * Store the estimate on the route. The paved % is only replaced if it was not entered by
 * hand (or overwriteManual). Returns true if paved_pct was set from the estimate.
 */
export function applyEstimate(route, result, overwriteManual = false) {
  route.surface = result;
  const manual = route.paved_source === "manual" || (route.paved_pct != null && route.paved_source == null);
  if (manual && !overwriteManual) return false;
  route.paved_pct = result.paved_pct;
  route.paved_source = result.paved_pct != null ? "estimated" : null;
  return true;
}
